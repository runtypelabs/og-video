// Build step: converts Twemoji SVGs (paths, circles and ellipses with solid fills only) into
// ogfx command buffers in the SVG's 36x36 units, so scenes draw icons as vectors without an SVG
// parser. Icons that use anything else are skipped and reported.
//   node scripts/twemoji.mjs <dir of twemoji svgs> > src/scenarios/twemoji.json
// Twemoji graphics: Copyright Twitter, Inc and other contributors, CC-BY 4.0.
import { readdir, readFile } from 'node:fs/promises'

/** Icon names scenarios accept, by Twemoji codepoint. */
export const NAMES = {
  bot: '1f916', bolt: '26a1', chat: '1f4ac', globe: '1f310', plug: '1f50c', laptop: '1f4bb',
  link: '1f517', clock: '23f0', mail: '1f4e7', phone: '1f4f1', database: '1f5c4', gear: '2699',
  search: '1f50d', key: '1f511', chart: '1f4c8',
  cart: '1f6d2', card: '1f4b3', money: '1f4b0', doc: '1f4c4', folder: '1f4c1', calendar: '1f4c5',
  bell: '1f514', user: '1f464', users: '1f465', sparkles: '2728', fire: '1f525', check: '2705',
  warning: '26a0', tools: '1f6e0', package: '1f4e6', cloud: '2601', star: '2b50',
  heart: '2764', eyes: '1f440', books: '1f4da', pencil: '270f', hash: '23-20e3', desktop: '1f5a5',
  memo: '1f4dd', stats: '1f4ca', earth: '1f30d', home: '1f3e0',
  news: '1f4f0', art: '1f3a8',
}
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi
const r3 = (n) => Math.round(n * 1000) / 1000

function pathCmds(d, out) {
  let x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, prev = ''
  for (const [, op, args] of d.matchAll(/([MmLlHhVvCcSsQqTtZz])([^MmLlHhVvCcSsQqTtZzAa]*)/g)) {
    const n = (args.match(NUM) || []).map(Number)
    const rel = op === op.toLowerCase()
    const O = op.toUpperCase()
    if (O === 'Z') { out.push(4); x = sx; y = sy; prev = O; continue }
    const step = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 }[O]
    for (let i = 0; i < n.length; i += step) {
      const a = n.slice(i, i + step)
      const bx = rel ? x : 0, by = rel ? y : 0
      let kind = O
      if (O === 'M' && i > 0) kind = 'L' // implicit lineto after a moveto
      if (kind === 'M') { x = a[0] + bx; y = a[1] + by; sx = x; sy = y; out.push(0, r3(x), r3(y)) }
      else if (kind === 'L') { x = a[0] + bx; y = a[1] + by; out.push(1, r3(x), r3(y)) }
      else if (kind === 'H') { x = a[0] + (rel ? x : 0); out.push(1, r3(x), r3(y)) }
      else if (kind === 'V') { y = a[0] + (rel ? y : 0); out.push(1, r3(x), r3(y)) }
      else if (kind === 'C' || kind === 'S') {
        let x1, y1
        if (kind === 'C') { x1 = a[0] + bx; y1 = a[1] + by }
        else if (prev === 'C' || prev === 'S') { x1 = 2 * x - cx; y1 = 2 * y - cy }
        else { x1 = x; y1 = y }
        const o = kind === 'C' ? 2 : 0
        const x2 = a[o] + bx, y2 = a[o + 1] + by
        x = a[o + 2] + bx; y = a[o + 3] + by
        cx = x2; cy = y2
        out.push(3, r3(x1), r3(y1), r3(x2), r3(y2), r3(x), r3(y))
      } else throw new Error(`unsupported path op ${op}`)
      prev = kind === 'M' || kind === 'L' || kind === 'H' || kind === 'V' ? 'L' : kind
    }
  }
  return out
}

function ellipseCmds(cx, cy, rx, ry, out) {
  const k = 0.5522847498
  out.push(0, r3(cx + rx), r3(cy),
    3, r3(cx + rx), r3(cy + ry * k), r3(cx + rx * k), r3(cy + ry), r3(cx), r3(cy + ry),
    3, r3(cx - rx * k), r3(cy + ry), r3(cx - rx), r3(cy + ry * k), r3(cx - rx), r3(cy),
    3, r3(cx - rx), r3(cy - ry * k), r3(cx - rx * k), r3(cy - ry), r3(cx), r3(cy - ry),
    3, r3(cx + rx * k), r3(cy - ry), r3(cx + rx), r3(cy - ry * k), r3(cx + rx), r3(cy), 4)
  return out
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]

function convert(svg) {
  if (attr(svg.match(/<svg[^>]*>/)[0], 'viewBox') !== '0 0 36 36') throw new Error('viewBox')
  if (/<(g|use|defs|rect|polygon|line|polyline)\b|transform=|clip-path|mask=|<linearGradient|<radialGradient/.test(svg))
    throw new Error('unsupported element')
  const layers = []
  for (const [tag, name] of svg.matchAll(/<(path|circle|ellipse)\b[^>]*>/g)) {
    const fill = attr(tag, 'fill')
    if (!fill || !/^#[0-9a-f]{3,6}$/i.test(fill)) throw new Error(`fill ${fill}`)
    if (attr(tag, 'fill-rule') || attr(tag, 'opacity')) throw new Error('fill-rule/opacity')
    const h = fill.length === 4 ? [...fill.slice(1)].map((c) => c + c).join('') : fill.slice(1)
    const cmds = []
    if (name === 'path') pathCmds(attr(tag, 'd'), cmds)
    else {
      const rx = Number(attr(tag, name === 'circle' ? 'r' : 'rx'))
      const ry = Number(attr(tag, name === 'circle' ? 'r' : 'ry'))
      ellipseCmds(Number(attr(tag, 'cx')), Number(attr(tag, 'cy')), rx, ry, cmds)
    }
    layers.push({ rgb: parseInt(h, 16), cmds })
  }
  return layers
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2]
  const files = new Set(await readdir(dir))
  const icons = {}
  for (const [name, code] of Object.entries(NAMES)) {
    if (!files.has(`${code}.svg`)) {
      console.error(`skip ${name}: missing ${code}.svg`)
      continue
    }
    try {
      icons[name] = convert(await readFile(`${dir}/${code}.svg`, 'utf8'))
    } catch (e) {
      console.error(`skip ${name} (${code}): ${e.message}`)
    }
  }
  process.stdout.write(JSON.stringify(icons))
}
