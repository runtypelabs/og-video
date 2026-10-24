// A small 2D rigid-body world for oriented boxes, after Erin Catto's Box2D-Lite: box-box
// collision by separating axes and edge clipping, sequential impulses with accumulated, clamped
// impulses, friction, warm starting and Baumgarte position correction. Units are frame pixels
// and seconds; y points down.
//
// It exists so scenes can precompute physics in setup and play the result back: run the world
// once, record every body's pose per frame, then state(i) reads frame i. It is deterministic: the
// same inputs give the same poses (plain double arithmetic in a fixed order; no clocks, no
// unordered iteration). Bodies that come to rest fall asleep and stay asleep until woken with
// `wake()`, so a settled pile is exactly still and its frames can be skipped and baked.

const ALLOWED_PENETRATION = 0.5
const BIAS = 0.2

/**
 * @typedef {{
 *   x: number, y: number, angle: number, vx: number, vy: number, w: number,
 *   hw: number, hh: number, invMass: number, invI: number, friction: number,
 *   asleep: boolean, still: number, data?: any,
 * }} Body
 */

/**
 * @param {{ gravity?: number, iterations?: number, sleepSpeed?: number, sleepTime?: number }} [opts]
 */
export function createWorld({ gravity = 2000, iterations = 10, sleepSpeed = 6, sleepTime = 0.3 } = {}) {
  /** @type {Body[]} */
  const bodies = []
  /** Contacts from the last step, by body pair, for warm starting. */
  let arbiters = new Map()
  let time = 0

  /**
   * Adds a box of size w x h centred on (x, y), rotated by `angle` radians. `density` 0 makes it
   * static (ground, walls).
   */
  function box({ x, y, w, h, angle = 0, vx = 0, vy = 0, spin = 0, density = 1, friction = 0.5, data }) {
    const mass = density * w * h
    const body = {
      x, y, angle, vx, vy, w: spin,
      hw: w / 2, hh: h / 2,
      invMass: mass > 0 ? 1 / mass : 0,
      invI: mass > 0 ? 12 / (mass * (w * w + h * h)) : 0,
      friction,
      asleep: false,
      still: 0,
      data,
      index: bodies.length,
    }
    bodies.push(body)
    return body
  }

  const dynamic = (b) => b.invMass > 0 && !b.asleep

  /** Advances the world by dt seconds. */
  function step(dt) {
    const invDt = dt > 0 ? 1 / dt : 0
    // Broad phase: sweep and prune on x over bounding circles, then the narrow phase on
    // overlapping pairs. Sorting is by (left edge, index), so the order is deterministic.
    const next = new Map()
    const n = bodies.length
    for (const b of bodies) {
      b.c = Math.cos(b.angle)
      b.s = Math.sin(b.angle)
      b.r = Math.hypot(b.hw, b.hh)
    }
    const order = bodies.map((b, i) => i).sort((i, j) => bodies[i].x - bodies[i].r - (bodies[j].x - bodies[j].r) || i - j)
    for (let oi = 0; oi < n; oi++) {
      const i0 = order[oi]
      const p = bodies[i0]
      const right = p.x + p.r
      for (let oj = oi + 1; oj < n; oj++) {
        const j0 = order[oj]
        const q = bodies[j0]
        if (q.x - q.r > right) break
        const [i, j] = i0 < j0 ? [i0, j0] : [j0, i0]
        const a = bodies[i]
        const b = bodies[j]
        if (!dynamic(a) && !dynamic(b)) continue
        const r = a.r + b.r
        const dx = b.x - a.x
        const dy = b.y - a.y
        if (Math.abs(dy) > r || dx * dx + dy * dy > r * r) continue
        const contacts = collide(a, b)
        if (!contacts.length) continue
        const key = i * n + j
        const old = arbiters.get(key)
        if (old) {
          // Warm start: keep the accumulated impulses of contacts that persisted.
          for (const c of contacts) {
            let best = null
            let bestD = 4
            for (const o of old.contacts) {
              const d = (o.px - c.px) ** 2 + (o.py - c.py) ** 2
              if (d < bestD) {
                bestD = d
                best = o
              }
            }
            if (best) {
              c.pn = best.pn
              c.pt = best.pt
            }
          }
        }
        next.set(key, { a, b, contacts, friction: Math.sqrt(a.friction * b.friction) })
      }
    }
    arbiters = next

    for (const b of bodies) {
      if (!dynamic(b)) continue
      b.vy += dt * gravity
    }
    for (const arb of arbiters.values()) preStep(arb, invDt)
    for (let k = 0; k < iterations; k++) for (const arb of arbiters.values()) applyImpulse(arb)

    for (const b of bodies) {
      if (!dynamic(b)) continue
      b.x += dt * b.vx
      b.y += dt * b.vy
      b.angle += dt * b.w
      // Sleep: slow for long enough, then frozen in place (treated as static) until woken.
      if (Math.hypot(b.vx, b.vy) < sleepSpeed && Math.abs(b.w) < sleepSpeed / 60) {
        b.still += dt
        if (b.still >= sleepTime) {
          b.asleep = true
          b.vx = b.vy = b.w = 0
        }
      } else b.still = 0
    }
    time += dt
  }

  /** Wakes every sleeping body (after removing a floor, say). */
  function wake() {
    for (const b of bodies) {
      b.asleep = false
      b.still = 0
    }
  }

  /** Removes a body (static or not). */
  function remove(body) {
    const i = bodies.indexOf(body)
    if (i >= 0) bodies.splice(i, 1)
    bodies.forEach((b, k) => (b.index = k))
    arbiters = new Map()
  }

  return {
    bodies,
    box,
    step,
    wake,
    remove,
    get time() {
      return time
    },
  }
}

// ---------------------------------------------------------------- solver

// A sleeping body acts as static: its mass terms must not count.
const im = (b) => (b.asleep ? 0 : b.invMass)
const ii = (b) => (b.asleep ? 0 : b.invI)

function preStep(arb, invDt) {
  const { a, b } = arb
  for (const c of arb.contacts) {
    const r1x = c.px - a.x, r1y = c.py - a.y
    const r2x = c.px - b.x, r2y = c.py - b.y
    const rn1 = r1x * c.nx + r1y * c.ny
    const rn2 = r2x * c.nx + r2y * c.ny
    const kN = im(a) + im(b) + ii(a) * (r1x * r1x + r1y * r1y - rn1 * rn1) + ii(b) * (r2x * r2x + r2y * r2y - rn2 * rn2)
    c.massN = 1 / kN
    const tx = c.ny, ty = -c.nx
    const rt1 = r1x * tx + r1y * ty
    const rt2 = r2x * tx + r2y * ty
    const kT = im(a) + im(b) + ii(a) * (r1x * r1x + r1y * r1y - rt1 * rt1) + ii(b) * (r2x * r2x + r2y * r2y - rt2 * rt2)
    c.massT = 1 / kT
    c.bias = -BIAS * invDt * Math.min(0, c.sep + ALLOWED_PENETRATION)
    const Px = c.pn * c.nx + c.pt * tx
    const Py = c.pn * c.ny + c.pt * ty
    impulse(a, b, r1x, r1y, r2x, r2y, Px, Py)
  }
}

function impulse(a, b, r1x, r1y, r2x, r2y, Px, Py) {
  if (!a.asleep) {
    a.vx -= a.invMass * Px
    a.vy -= a.invMass * Py
    a.w -= a.invI * (r1x * Py - r1y * Px)
  }
  if (!b.asleep) {
    b.vx += b.invMass * Px
    b.vy += b.invMass * Py
    b.w += b.invI * (r2x * Py - r2y * Px)
  }
}

function applyImpulse(arb) {
  const { a, b } = arb
  const ia = a.asleep ? 0 : 1
  const ib = b.asleep ? 0 : 1
  for (const c of arb.contacts) {
    const r1x = c.px - a.x, r1y = c.py - a.y
    const r2x = c.px - b.x, r2y = c.py - b.y
    let dvx = ib * (b.vx - b.w * r2y) - ia * (a.vx - a.w * r1y)
    let dvy = ib * (b.vy + b.w * r2x) - ia * (a.vy + a.w * r1x)
    const vn = dvx * c.nx + dvy * c.ny
    let dPn = c.massN * (-vn + c.bias)
    const pn0 = c.pn
    c.pn = Math.max(pn0 + dPn, 0)
    dPn = c.pn - pn0
    impulse(a, b, r1x, r1y, r2x, r2y, dPn * c.nx, dPn * c.ny)

    dvx = ib * (b.vx - b.w * r2y) - ia * (a.vx - a.w * r1y)
    dvy = ib * (b.vy + b.w * r2x) - ia * (a.vy + a.w * r1x)
    const tx = c.ny, ty = -c.nx
    const vt = dvx * tx + dvy * ty
    let dPt = c.massT * -vt
    const maxPt = arb.friction * c.pn
    const pt0 = c.pt
    c.pt = Math.max(-maxPt, Math.min(pt0 + dPt, maxPt))
    dPt = c.pt - pt0
    impulse(a, b, r1x, r1y, r2x, r2y, dPt * tx, dPt * ty)
  }
}

// ---------------------------------------------------------------- collision (box vs box)

/** Up to two contact points { px, py, nx, ny, sep } with the normal pointing from a to b. */
function collide(A, B) {
  const hAx = A.hw, hAy = A.hh, hBx = B.hw, hBy = B.hh
  const ca = A.c, sa = A.s
  const cb = B.c, sb = B.s
  // Rotation matrices as columns: col1 = (c, s), col2 = (-s, c).
  const dpx = B.x - A.x, dpy = B.y - A.y
  const dAx = ca * dpx + sa * dpy, dAy = -sa * dpx + ca * dpy
  const dBx = cb * dpx + sb * dpy, dBy = -sb * dpx + cb * dpy
  // C = RotA^T RotB
  const c11 = ca * cb + sa * sb, c12 = -ca * sb + sa * cb
  const c21 = -sa * cb + ca * sb, c22 = sa * sb + ca * cb
  const a11 = Math.abs(c11), a12 = Math.abs(c12), a21 = Math.abs(c21), a22 = Math.abs(c22)

  const faceAx = Math.abs(dAx) - hAx - (a11 * hBx + a12 * hBy)
  const faceAy = Math.abs(dAy) - hAy - (a21 * hBx + a22 * hBy)
  if (faceAx > 0 || faceAy > 0) return []
  const faceBx = Math.abs(dBx) - (a11 * hAx + a21 * hAy) - hBx
  const faceBy = Math.abs(dBy) - (a12 * hAx + a22 * hAy) - hBy
  if (faceBx > 0 || faceBy > 0) return []

  const relTol = 0.95, absTol = 0.01
  let axis = 0
  let sep = faceAx
  let nx = dAx > 0 ? ca : -ca, ny = dAx > 0 ? sa : -sa
  if (faceAy > relTol * sep + absTol * hAy) {
    axis = 1
    sep = faceAy
    nx = dAy > 0 ? -sa : sa
    ny = dAy > 0 ? ca : -ca
  }
  if (faceBx > relTol * sep + absTol * hBx) {
    axis = 2
    sep = faceBx
    nx = dBx > 0 ? cb : -cb
    ny = dBx > 0 ? sb : -sb
  }
  if (faceBy > relTol * sep + absTol * hBy) {
    axis = 3
    sep = faceBy
    nx = dBy > 0 ? -sb : sb
    ny = dBy > 0 ? cb : -cb
  }

  let fnx, fny, front, snx, sny, side, negSide, posSide, inc
  if (axis === 0) {
    fnx = nx; fny = ny
    front = A.x * fnx + A.y * fny + hAx
    snx = -sa; sny = ca
    side = A.x * snx + A.y * sny
    negSide = -side + hAy
    posSide = side + hAy
    inc = incidentEdge(hBx, hBy, B.x, B.y, cb, sb, fnx, fny)
  } else if (axis === 1) {
    fnx = nx; fny = ny
    front = A.x * fnx + A.y * fny + hAy
    snx = ca; sny = sa
    side = A.x * snx + A.y * sny
    negSide = -side + hAx
    posSide = side + hAx
    inc = incidentEdge(hBx, hBy, B.x, B.y, cb, sb, fnx, fny)
  } else if (axis === 2) {
    fnx = -nx; fny = -ny
    front = B.x * fnx + B.y * fny + hBx
    snx = -sb; sny = cb
    side = B.x * snx + B.y * sny
    negSide = -side + hBy
    posSide = side + hBy
    inc = incidentEdge(hAx, hAy, A.x, A.y, ca, sa, fnx, fny)
  } else {
    fnx = -nx; fny = -ny
    front = B.x * fnx + B.y * fny + hBy
    snx = cb; sny = sb
    side = B.x * snx + B.y * sny
    negSide = -side + hBx
    posSide = side + hBx
    inc = incidentEdge(hAx, hAy, A.x, A.y, ca, sa, fnx, fny)
  }

  const c1 = clip(inc, -snx, -sny, negSide)
  if (c1.length < 2) return []
  const c2 = clip(c1, snx, sny, posSide)
  if (c2.length < 2) return []
  const out = []
  for (const [x, y] of c2) {
    const s = fnx * x + fny * y - front
    if (s <= 0) out.push({ px: x - s * fnx, py: y - s * fny, nx, ny, sep: s, pn: 0, pt: 0, massN: 0, massT: 0, bias: 0 })
  }
  return out
}

/** The edge of box (h, pos, rot) most anti-parallel to `normal`, as two world points. */
function incidentEdge(hx, hy, px, py, c, s, nx, ny) {
  // n = -(Rot^T normal)
  const lx = -(c * nx + s * ny)
  const ly = -(-s * nx + c * ny)
  let v0, v1
  if (Math.abs(lx) > Math.abs(ly)) {
    if (lx > 0) { v0 = [hx, -hy]; v1 = [hx, hy] } else { v0 = [-hx, hy]; v1 = [-hx, -hy] }
  } else if (ly > 0) { v0 = [hx, hy]; v1 = [-hx, hy] } else { v0 = [-hx, -hy]; v1 = [hx, -hy] }
  const world = ([x, y]) => [px + c * x - s * y, py + s * x + c * y]
  return [world(v0), world(v1)]
}

/** Clips a segment to the half-plane n . p <= offset. */
function clip([p0, p1], nx, ny, offset) {
  const out = []
  const d0 = nx * p0[0] + ny * p0[1] - offset
  const d1 = nx * p1[0] + ny * p1[1] - offset
  if (d0 <= 0) out.push(p0)
  if (d1 <= 0) out.push(p1)
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1)
    out.push([p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1])])
  }
  return out
}
