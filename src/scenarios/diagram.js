// diagram: an architecture card. A dark side panel with a pixel wordmark, the title and counting
// stats; on the right, lanes of nodes unfold, edges draw between them, and packets travel the
// edges while the nodes they reach pulse.
//
// Every drawable is an item. Once an item's last tween has ended (and every earlier item in its
// paint group has too) it is baked into a cached layer; only the rest are redrawn per frame, and
// only the macroblocks they touch are re-checked for the encoder.
//
// The first 22 frames (until the lanes start to unfold) depend only on brand and accent.
import { gsap } from 'gsap'
import { defineScenario } from '../scenario.js'
import { p } from '../schema.js'
import { rrect, rect, transform } from '../gfx.js'
import { lu } from '../text.js'
import { pixelText } from '../pixelfont.js'
import ICONS from './twemoji.json' with { type: 'json' }
import { settleTimes, bakedAt } from '../gsap.js'

const W = 1200
const H = 630
const SIDE = 360

const node = p.object({
  id: p.string({ max: 32, optional: true }),
  label: p.string({ max: 40 }),
  sub: p.string({ max: 40, default: '' }),
  icon: p.string({ max: 16, default: 'globe' }),
  accent: p.color({ optional: true }),
})
const lane = p.object({ label: p.string({ max: 24 }), nodes: p.array(node, { min: 1, max: 6 }) })

export const DEFAULT_LANES = [
  { label: 'Agents', nodes: [{ label: 'Support agent', sub: 'Answers tickets', icon: 'bot' }, { label: 'Triage flow', sub: '4 steps', icon: 'bolt' }] },
  { label: 'Surfaces', nodes: [{ label: 'Slack', sub: '#support', icon: 'chat' }, { label: 'Email', sub: 'help@', icon: 'mail' }, { label: 'API', sub: 'REST', icon: 'globe' }] },
]

export const diagram = defineScenario({
  id: 'diagram',
  version: 1,
  video: { width: W, height: H, fps: 60, frames: 420 },
  params: p.object({
    title: p.string({ max: 80, default: 'A support agent that answers in Slack and email' }),
    tagline: p.string({ max: 120, default: '' }),
    brand: p.string({ max: 12, default: 'OG VIDEO', pattern: /^[A-Za-z0-9 .!+/-]*$/ }),
    accent: p.color({ default: '#3b82f6' }),
    stats: p.array(p.object({ value: p.int({ min: 0, max: 999 }), label: p.string({ max: 16 }) }), { max: 4, default: [] }),
    // Lanes as JSON, or `graph` as shorthand: "Agents: Support agent@bot, Triage@bolt | Surfaces: Slack@chat".
    lanes: p.array(lane, { min: 1, max: 3, optional: true }),
    graph: p.string({ max: 600, optional: true }),
    // [from, to] pairs of node ids (or labels). Default: each node to its neighbour in the lane before.
    edges: p.array(p.array(p.string({ max: 40 }), { min: 2, max: 2 }), { max: 16, optional: true }),
  }),
  prefix: { frames: 22, key: (q) => `${q.brand.toUpperCase()}|${q.accent}` },
  meta: (q) => ({ title: q.title, description: q.tagline || undefined }),
  setup,
})

/** "Lane: Node@icon, Node | Lane: ..." -> lanes. */
export function parseGraph(graph) {
  return graph
    .split('|')
    .map((part) => {
      const [label, rest = ''] = part.split(':')
      const nodes = rest
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [l, icon] = s.split('@')
          return { label: l.trim(), sub: '', icon: icon?.trim() || 'globe' }
        })
      return { label: label.trim(), nodes }
    })
    .filter((l) => l.label && l.nodes.length)
    .slice(0, 3)
    .map((l) => ({ ...l, nodes: l.nodes.slice(0, 6) }))
}

// ---------------------------------------------------------------- layout

const HEAD = 11
const LANE_W = 200
const LANE_GAP = 64
const PAD = 12
const NODE_H = 44
const NODE_GAP = 10

/** Lanes, nodes and edge polylines in diagram units (scaled to fit later). */
function layout(text, lanes, edgePairs) {
  const headH = 1 + 16 + text.metrics('semibold', HEAD).normal
  const rows = Math.max(...lanes.map((l) => l.nodes.length))
  const laneH = headH + PAD + rows * NODE_H + (rows - 1) * NODE_GAP + PAD
  const panels = []
  const nodes = []
  const byKey = new Map()
  lanes.forEach((l, li) => {
    const x = li * (LANE_W + LANE_GAP)
    panels.push({ label: l.label, x, y: 0, w: LANE_W, h: laneH })
    const n = l.nodes.length
    const top = headH + PAD + ((rows - n) * (NODE_H + NODE_GAP)) / 2
    l.nodes.forEach((nd, ni) => {
      const id = nd.id ?? `${li}.${ni}`
      const out = { ...nd, id, lane: li, x: x + PAD, y: top + ni * (NODE_H + NODE_GAP), w: LANE_W - 2 * PAD, h: NODE_H }
      nodes.push(out)
      byKey.set(id, out)
      byKey.set(nd.label.toLowerCase(), out)
    })
  })
  let pairs = edgePairs
  if (!pairs) {
    pairs = []
    for (let li = 1; li < lanes.length; li++) {
      const prev = nodes.filter((n) => n.lane === li - 1)
      nodes.filter((n) => n.lane === li).forEach((n, j) => pairs.push([prev[Math.min(j, prev.length - 1)].id, n.id]))
    }
  }
  const edges = []
  for (const [a, b] of pairs) {
    const from = byKey.get(a) ?? byKey.get(a.toLowerCase())
    const to = byKey.get(b) ?? byKey.get(b.toLowerCase())
    if (!from || !to || from === to || from.lane === to.lane) continue
    const [l, r] = from.lane < to.lane ? [from, to] : [to, from]
    const x1 = l.x + l.w
    const y1 = l.y + l.h / 2
    const x2 = r.x
    const y2 = r.y + r.h / 2
    const midX = (x1 + x2) / 2
    let points = Math.abs(y1 - y2) < 1 ? [[x1, y1], [x2, y2]] : [[x1, y1], [midX, y1], [midX, y2], [x2, y2]]
    if (from !== l) points = points.reverse()
    edges.push({ from: from.id, to: to.id, points })
  }
  return { panels, nodes, edges, width: lanes.length * LANE_W + (lanes.length - 1) * LANE_GAP, height: laneH }
}

function pointAt(points, d) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const seg = Math.hypot(bx - ax, by - ay)
    if (d <= seg || i === points.length - 1) {
      const t = seg === 0 ? 0 : Math.min(d / seg, 1)
      return [ax + (bx - ax) * t, ay + (by - ay) * t]
    }
    d -= seg
  }
  return points[points.length - 1]
}

/**
 * The visible part of a 2px, miter-joined, butt-capped stroke along an axis-aligned polyline,
 * dashed to its first `len` units: one rectangle per segment, extended by the half width past an
 * interior corner so the miter square is filled.
 */
function strokeCmds(points, len) {
  const out = []
  let left = len
  for (let i = 1; i < points.length && left > 0; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const seg = Math.hypot(bx - ax, by - ay)
    if (seg === 0) continue
    const vis = Math.min(seg, left)
    const dx = (bx - ax) / seg
    const dy = (by - ay) / seg
    const ext = vis === seg && left > seg && i < points.length - 1 ? 1 : 0
    const ex = ax + dx * (vis + ext)
    const ey = ay + dy * (vis + ext)
    out.push(...rect(
      Math.min(ax, ex) - (dx === 0 ? 1 : 0), Math.min(ay, ey) - (dy === 0 ? 1 : 0),
      Math.max(ax, ex) + (dx === 0 ? 1 : 0), Math.max(ay, ey) + (dy === 0 ? 1 : 0),
    ))
    left -= seg
  }
  return out
}

// ---------------------------------------------------------------- scene

function setup(ctx, q) {
  const { text } = ctx
  const accent = q.accent
  const lanes = q.lanes ?? (q.graph ? parseGraph(q.graph) : null) ?? DEFAULT_LANES
  if (!lanes.length) throw new Error('diagram: no lanes')
  const L = layout(text, lanes, q.edges)

  // Fit the diagram into the right panel (40px padding, tagline row reserved when there is one).
  const tagH = q.tagline ? 44 : 0
  const availW = W - SIDE - 80
  const availH = H - 80 - tagH
  const S = Math.min(availW / L.width, availH / L.height, 1.6)
  const X0 = SIDE + (W - SIDE - L.width * S) / 2
  const Y0 = 40 + (availH - L.height * S) / 2
  const sc = (n) => n * S

  const sidePath = ctx.path(rect(0, 0, SIDE, H))
  const items = []
  const item = (group, targets, draw) => {
    const it = { group, targets, draw, settle: 0 }
    items.push(it)
    return it
  }

  // ---- left panel: 44/36 padding, a space-between column of wordmark, title and stats.
  const brand = pixelText(q.brand)
  const brandW = Math.max(brand.cols * 200 - 35, 0)
  const LK = brand.cols ? Math.min(28 / 965, 288 / brandW) : 0
  const logoH = brand.cols ? 965 * LK : 0
  const pxPath = ctx.path(rect(0, 0, 165, 165))
  const px = brand.cells.map(([col, row]) => ({ col, row, o: { opacity: 0, fill: accent } }))
  for (const c of px)
    item(`px${c.col},${c.row}`, [c.o], (g) => g.fill(pxPath, c.o.fill, { alpha: c.o.opacity, transform: [LK, 0, 0, LK, 36 + c.col * 200 * LK, 44 + c.row * 200 * LK] }))

  const titleSize = 36
  const titleLH = lu(titleSize * 1.1)
  const lines = text.wrap('semibold', q.title, titleSize, 288, { letterSpacing: -0.03 * titleSize, maxLines: 3 })
  const titleH = lines.length * titleLH
  const statsH = q.stats.length * 48 + Math.max(0, q.stats.length - 1) * 12
  const gap = Math.max(0, (H - 88 - logoH - titleH - statsH) / 2)
  const titleTop = lu(44 + logoH + gap)
  const statsTop = lu(titleTop + titleH + gap)
  const titleBase = text.baselineIn('semibold', titleSize, titleLH)
  const words = []
  lines.forEach((line, li) => {
    for (const w of line.words) {
      const sp = ctx.sprite([{ cmds: w.run.cmds(36 + w.x, titleTop + li * titleLH + titleBase), color: 0xffffff }], { margin: 20 })
      const o = { opacity: 0, blur: 0 }
      words.push(o)
      item(`word${words.length}`, [o], (g) => g.draw(sp, o))
    }
  })

  // Stats: a 48px rounded box whose number counts up, then a label.
  const numSize = 28
  const numNormal = text.metrics('semibold', numSize).normal
  const numBase = (48 - numNormal) / 2 + text.baselineIn('semibold', numSize, numNormal)
  const labelNormal = text.metrics('regular', 20).normal
  const labelBase = Math.round((48 - labelNormal) / 2 + text.baselineIn('regular', 20, labelNormal))
  const stats = q.stats.map((stat, i) => {
    const top = statsTop + i * 60
    const looks = new Map()
    const look = (value) => {
      if (!looks.has(value)) {
        const run = text.run('semibold', String(value), numSize, { features: { tnum: true } })
        const w = Math.max(48, 24 + run.advance)
        looks.set(value, { w, box: ctx.path(rrect(0, 0, w, 48, 12)), num: ctx.path(run.cmds((w - run.advance) / 2, Math.round(numBase))) })
      }
      return looks.get(value)
    }
    const labelPath = ctx.path(text.run('regular', stat.label, 20).cmds(0, 0))
    const o = { opacity: 0, scale: 0.6, text: 0, label: 0 }
    const counter = { n: 0 }
    item(`stat${i}`, [o, counter], (g) => {
      const l = look(o.text)
      if (o.opacity > 0) {
        const k = o.scale
        const t = [k, 0, 0, k, 36 + (l.w / 2) * (1 - k), top + 24 * (1 - k)]
        g.fill(l.box, 0xffffff, { alpha: 0.1 * o.opacity, transform: t })
        g.fill(l.num, 0xffffff, { alpha: o.opacity, transform: t })
      }
      if (o.label > 0) g.fill(labelPath, 0xa0a0a0, { alpha: o.label, transform: [1, 0, 0, 1, 36 + l.w + 12, top + labelBase] })
    })
    return { o, counter, value: stat.value }
  })

  // ---- right panel: lanes (1px border, radius 8, header with an underline), letters pop on.
  const headSize = HEAD * S
  const headNormal = text.metrics('semibold', headSize).normal
  const headBase = text.baselineIn('semibold', headSize, headNormal)
  const laneStates = L.panels.map((panel) => {
    const lx = X0 + sc(panel.x)
    const ly = Y0 + sc(panel.y)
    const pw = sc(panel.w)
    const ph = sc(panel.h)
    const ruleY = ly + 1 + 16 * S + headNormal
    const sp = ctx.sprite(
      [
        { cmds: rrect(lx, ly, pw, ph, 8), color: 0xf6f8fa },
        { cmds: [...rrect(lx, ly, pw, ph, 8), ...rrect(lx + 1, ly + 1, pw - 2, ph - 2, 7)], color: 0xe1e4e8, evenodd: true },
        { cmds: rect(lx + 1, ruleY, lx + pw - 1, ruleY + 1), color: 0xe1e4e8 },
      ],
      { margin: 1 },
    )
    const st = { reveal: 0 }
    item('main', [st], (g) => {
      if (st.reveal > 0) g.draw(sp, { clip: [0, ly, W, ly + st.reveal * ph] })
    })
    const letters = []
    let x = lx + 1 + 12 * S
    for (const ch of panel.label.toUpperCase()) {
      const run = text.run('semibold', ch, headSize, { letterSpacing: 0.05 * headSize })
      letters.push({ o: { opacity: 0 }, path: ch.trim() ? ctx.path(run.cmds(x, ly + 1 + 8 * S + headBase)) : null })
      x += run.advance
    }
    item('main', letters.map((l) => l.o), (g) => {
      for (const l of letters) if (l.o.opacity > 0) g.fill(l.path, 0x1f2328, { alpha: l.o.opacity })
    })
    return { st, letters: letters.map((l) => l.o) }
  })

  // Edges: 2px accent, drawn on by dash offset.
  const edges = L.edges.map((edge) => {
    const points = edge.points.map(([x, y]) => [X0 + sc(x), Y0 + sc(y)])
    let length = 0
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    const o = { off: length }
    item('main', [o], (g) => {
      const len = length - o.off
      if (len > 0.01) g.fill(ctx.path(strokeCmds(points, len)), accent)
    })
    return { edge, points, length, o, packet: { x: 0, y: 0, opacity: 0 } }
  })

  // Nodes: white cards wiped on from the left, with an icon, label, sub-label and optional
  // accent bar; a ring pulses when a packet arrives.
  const labelSize = 13 * S
  const subSize = 10 * S
  const labelLH = lu(labelSize * 1.2)
  const subLH = lu(subSize * 1.2)
  const nodeStates = new Map()
  const rings = []
  for (const nd of L.nodes) {
    const nx = X0 + sc(nd.x)
    const ny = Y0 + sc(nd.y)
    const nw = sc(nd.w)
    const nh = sc(nd.h)
    const cx0 = nx + 1 + 12 * S
    const cx1 = nx + nw - 1 - 12 * S
    const cy0 = ny + 1 + 8 * S
    const cy1 = ny + nh - 1 - 8 * S
    const icon = 24 * S
    const ix = cx0
    const iy = cy0 + (cy1 - cy0 - icon) / 2
    const tx = ix + icon + 8 * S
    const colTop = cy0 + (cy1 - cy0 - (labelLH + (nd.sub ? subLH : 0))) / 2
    const label = text.fit('semibold', nd.label, labelSize, cx1 - tx)
    const sub = nd.sub ? text.fit('regular', nd.sub, subSize, cx1 - tx) : null
    const e = 13 * S
    const art = (ICONS[nd.icon] ?? ICONS.globe).map((l) => ({ cmds: transform(l.cmds, e / 36, ix + (icon - e) / 2, iy + (icon - e) / 2), color: l.rgb }))
    const sp = ctx.sprite(
      [
        { cmds: rrect(nx, ny, nw, nh, 8), color: 0xffffff },
        { cmds: [...rrect(nx, ny, nw, nh, 8), ...rrect(nx + 1, ny + 1, nw - 2, nh - 2, 7)], color: 0xd0d7de, evenodd: true },
        { cmds: rrect(ix, iy, icon, icon, 4), color: 0xf0f3f6 },
        ...art,
        { cmds: label.cmds(tx, colTop + text.baselineIn('semibold', labelSize, labelLH)), color: 0x1f2328 },
        sub && { cmds: sub.cmds(tx, colTop + labelLH + text.baselineIn('regular', subSize, subLH)), color: 0x57606a },
      ],
      { margin: 2 },
    )
    const o = { wipe: 0, bar: 0 }
    const ring = { ring: 0 }
    const barColor = nd.accent ?? (nd.lane === 0 ? accent : null)
    nodeStates.set(nd.id, { o, ring, bar: Boolean(barColor) })
    const barX0 = nx - 0.5
    const barX1 = nx + 2.5
    item('main', [o], (g) => {
      const clipR = nx + o.wipe * (nw + 6)
      g.draw(sp, { clip: [nx - 6, ny - 6, clipR, ny + nh + 6] })
      if (barColor && o.bar > 0 && clipR > barX0) {
        // 3px wide, rounded on the left, growing from its centre.
        const hh = (nh + 1) * o.bar
        const top = ny - 0.5 + (nh + 1 - hh) / 2
        const r = Math.min(3, hh / 2)
        const x1 = Math.min(barX1, clipR)
        const c = r * 0.5522847498
        g.fill(ctx.path([
          0, barX0 + r, top, 1, x1, top, 1, x1, top + hh, 1, barX0 + r, top + hh,
          3, barX0 + r - c, top + hh, barX0, top + hh - r + c, barX0, top + hh - r,
          1, barX0, top + r,
          3, barX0, top + r - c, barX0 + r - c, top, barX0 + r, top, 4,
        ]), barColor)
      }
    })
    const rx = nx - 0.5, ry = ny - 0.5, rw = nw + 1, rh = nh + 1
    const ringSprite = ctx.sprite([{ cmds: [...rrect(rx - 4, ry - 4, rw + 8, rh + 8, 12), ...rrect(rx, ry, rw, rh, 8)], color: accent, alpha: 0.35, evenodd: true }], { margin: 1 })
    rings.push([ring, (g) => g.draw(ringSprite, { opacity: ring.ring })])
  }
  // Rings never overlap another node, so they paint after all of them: a node then bakes as soon
  // as its own wipe ends, not when the last ring fades.
  item('rings', rings.map(([o]) => o), (g) => rings.forEach(([, draw]) => draw(g)))

  const packetPath = ctx.path(rrect(0, 0, 10, 10, 2))
  const packetProxies = []
  const packets = item('packets', edges.map((e) => e.packet), (g) => {
    for (const { packet } of edges) if (packet.opacity > 0) g.fill(packetPath, accent, { alpha: packet.opacity, transform: [1, 0, 0, 1, packet.x - 5, packet.y - 5] })
  })

  let tagline = null
  const tag = { opacity: 0, blur: 0 }
  if (q.tagline) {
    const normal = text.metrics('regular', 14).normal
    const run = text.fit('regular', q.tagline, 14, W - SIDE - 80)
    tagline = ctx.sprite([{ cmds: run.cmds(SIDE + 40, H - 32 - normal + text.baselineIn('regular', 14, normal)), color: 0x57606a }], { margin: 20 })
    item('tagline', [tag], (g) => g.draw(tagline, tag))
  }

  // ---------------------------------------------------------------- timeline
  const tl = gsap.timeline({ paused: true })
  const colTime = (c) => 0.15 + c * Math.min(0.03, 0.45 / Math.max(brand.cols, 1))
  for (const c of px) {
    const at = colTime(c.col) + c.row * 0.01
    tl.fromTo(c.o, { opacity: 0 }, { opacity: 1, duration: 0.04, ease: 'none' }, at)
    tl.fromTo(c.o, { fill: accent }, { fill: '#ffffff', duration: 0.4, ease: 'power2.out' }, at + 0.1)
  }
  words.forEach((o, i) => tl.fromTo(o, { opacity: 0, blur: 6 }, { opacity: 1, blur: 0, duration: 0.16, ease: 'power3.out' }, 0.75 + i * 0.067))
  stats.forEach(({ o, counter, value }, i) => {
    const at = 1.05 + i * 0.12
    tl.fromTo(o, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'expo.out' }, at)
    const steps = Math.min(Math.max(value, 1), 30)
    tl.fromTo(counter, { n: 0 }, {
      n: value,
      duration: 0.25 + 0.03 * steps,
      ease: `steps(${steps})`,
      onUpdate: () => {
        o.text = Math.round(counter.n)
      },
    }, at + 0.05)
    tl.fromTo(o, { label: 0 }, { label: 1, duration: 0.2, ease: 'power2.out' }, at + 0.1)
  })
  laneStates.forEach(({ st, letters }, i) => {
    const at = 0.35 + i * 0.12
    tl.fromTo(st, { reveal: 0 }, { reveal: 1, duration: 0.55, ease: 'expo.out' }, at)
    letters.forEach((l, j) => tl.fromTo(l, { opacity: 0 }, { opacity: 1, duration: 0.01 }, at + 0.15 + j * 0.025))
  })

  const step = (natural, budget, count) => Math.min(natural, budget / Math.max(count, 1))
  let at = 0.85
  for (let li = 0; li < lanes.length; li++) {
    const laneNodes = L.nodes.filter((n) => n.lane === li)
    const s = step(0.12, 0.55, laneNodes.length)
    laneNodes.forEach((nd, i) => {
      const { o, bar } = nodeStates.get(nd.id)
      const t = at + i * s
      if (bar) tl.fromTo(o, { bar: 0 }, { bar: 1, duration: 0.18, ease: 'power3.out' }, t)
      tl.fromTo(o, { wipe: 0 }, { wipe: 1, duration: 0.38, ease: 'expo.out' }, t + (bar ? 0.1 : 0))
    })
    at += laneNodes.length * s + 0.1
  }
  const EDGE_AT = at + 0.1
  const edgeStep = step(0.08, 0.4, edges.length)
  edges.forEach(({ o, length }, i) => tl.fromTo(o, { off: length }, { off: 0, duration: 0.45, ease: 'power2.inOut' }, EDGE_AT + i * edgeStep))

  const ring = (id, t) => {
    const target = nodeStates.get(id).ring
    tl.fromTo(target, { ring: 0 }, { ring: 1, duration: 0.08, ease: 'power2.out' }, t)
    tl.to(target, { ring: 0, duration: 0.45, ease: 'power2.out' }, t + 0.1)
  }
  const LIVE_END_BY = 5.6
  const LIVE_AT = EDGE_AT + edges.length * edgeStep + 0.55
  const packetStep = step(0.14, 0.5, edges.length)
  const tripFor = (length) => Math.min(0.5 + length / 1600, 0.8)
  const PAUSE = 0.25
  const naturalSpan = edges.reduce((end, e, i) => Math.max(end, i * packetStep + 2 * tripFor(e.length) + PAUSE), 0)
  const speed = Math.min(1, (LIVE_END_BY - LIVE_AT) / Math.max(naturalSpan, 0.01))
  const travel = ({ points, length, packet }, t, reverse) => {
    const d = { d: 0 }
    packetProxies.push(d)
    const place = () => {
      const [x, y] = pointAt(points, reverse ? length - d.d : d.d)
      packet.x = x
      packet.y = y
    }
    const dur = tripFor(length) * speed
    tl.fromTo(packet, { opacity: 0 }, { opacity: 1, duration: 0.06 }, t)
    tl.fromTo(d, { d: 0 }, { d: length, duration: dur, ease: 'power2.inOut', onUpdate: place, onStart: place }, t)
    tl.to(packet, { opacity: 0, duration: 0.06 }, t + dur - 0.04)
    return t + dur
  }
  let liveEnd = LIVE_AT
  edges.forEach((e, i) => {
    const start = LIVE_AT + i * packetStep * speed
    ring(e.edge.from, start)
    const arrive = travel(e, start, false)
    ring(e.edge.to, arrive - 0.02)
    const back = travel(e, arrive + PAUSE * speed, true)
    ring(e.edge.from, back - 0.02)
    liveEnd = Math.max(liveEnd, back)
  })
  // The packets item also follows its travel proxies (they move packets from onUpdate).
  packets.targets.push(...packetProxies)
  if (tagline) tl.fromTo(tag, { opacity: 0, blur: 6 }, { opacity: 1, blur: 0, duration: 0.25, ease: 'power3.out' }, Math.min(liveEnd + 0.1, 5.2))

  settleTimes(tl, items)

  // ---------------------------------------------------------------- frames
  return {
    state(i) {
      const t = i / ctx.fps
      tl.seek(t, false)
      const baked = bakedAt(items, t)
      return { baked: baked.map((b) => (b ? 1 : 0)).join(''), live: items.map((it, j) => (baked[j] ? 0 : it.targets)) }
    },
    draw(g, s) {
      g.layer(s.baked, () => {
        g.clear(0xffffff)
        g.fill(sidePath, 0x111111)
        items.forEach((it, j) => s.baked[j] === '1' && it.draw(g))
      })
      items.forEach((it, j) => s.baked[j] === '0' && it.draw(g))
    },
    dispose: () => tl.kill(),
  }
}
