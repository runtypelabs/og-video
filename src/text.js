// Text shaping and layout with Chrome's rounding rules, so scenes ported from HTML land on the
// same pixels as a browser render.
//
// fontkit shapes with the same GSUB/GPOS results as HarfBuzz for typical Latin fonts and is plain
// JS, so it runs in Workers, which forbid the runtime wasm compilation harfbuzzjs needs.

// Blink turns these off whenever letter-spacing is non-zero.
const NO_LIGA = { liga: false, clig: false, dlig: false, hlig: false, calt: false }

const r2 = (n) => Math.round(n * 100) / 100
/** Blink LayoutUnit: 1/64 px, truncated. */
export const lu = (n) => Math.floor(n * 64 + 1e-6) / 64

const OP = { moveTo: 0, lineTo: 1, quadraticCurveTo: 2, bezierCurveTo: 3 }

/** A glyph outline as an ogfx command buffer, placed at (ox, oy) and scaled from font units. */
function glyphCmds(out, commands, ox, oy, k) {
  for (const { command, args } of commands) {
    if (command === 'closePath') {
      out.push(4)
      continue
    }
    out.push(OP[command])
    for (let i = 0; i < args.length; i += 2) out.push(r2(ox + args[i] * k), r2(oy - args[i + 1] * k))
  }
  return out
}

/**
 * @param {any} fontkit the fontkit module
 * @param {Record<string, ArrayBuffer | Uint8Array>} fontBytes font name -> TTF/OTF bytes
 */
export function createTextEngine(fontkit, fontBytes) {
  const fonts = {}
  for (const [key, bytes] of Object.entries(fontBytes)) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    // fontkit wants a Node Buffer-like object; a Uint8Array works in both runtimes.
    const font = fontkit.create(buf)
    fonts[key] = {
      font,
      upem: font.unitsPerEm,
      asc: font.hhea.ascent / font.unitsPerEm,
      desc: -font.hhea.descent / font.unitsPerEm,
      gap: font.hhea.lineGap / font.unitsPerEm,
    }
  }
  const get = (key) => {
    const f = fonts[key]
    if (!f) throw new Error(`unknown font "${key}" (have: ${Object.keys(fonts).join(', ')})`)
    return f
  }

  /**
   * Shapes one run of text.
   * @returns {import('../types/index.js').TextRun}
   */
  function run(fontKey, text, size, { letterSpacing = 0, features } = {}) {
    const f = get(fontKey)
    const shaped = f.font.layout(text, features ?? (letterSpacing ? NO_LIGA : undefined))
    const k = size / f.upem
    const glyphs = []
    let pen = 0
    shaped.glyphs.forEach((glyph, i) => {
      const pos = shaped.positions[i]
      glyphs.push({ glyph, x: pen + pos.xOffset * k, y: pos.yOffset * k, index: i })
      pen += pos.xAdvance * k + letterSpacing
    })
    return {
      advance: pen,
      glyphCount: glyphs.length,
      /** Pen position after glyph `index`. */
      rightOf(index) {
        return index + 1 < glyphs.length ? glyphs[index + 1].x : pen
      },
      /** Outlines placed with the run's origin at (x, baseline); `only` keeps one glyph. */
      cmds(x, baseline, only) {
        const out = []
        for (const g of glyphs) {
          if (only !== undefined && g.index !== only) continue
          // Skia with subpixel positioning: x snaps to 1/4 px, y to whole pixels.
          glyphCmds(out, g.glyph.path.commands, Math.round((x + g.x) * 4) / 4, Math.round(baseline - g.y), k)
        }
        return out
      },
    }
  }

  /**
   * Blink (FontMetrics::AscentDescentWithHacks) rounds ascent and descent to whole pixels; with
   * subpixel positioning, a descent that rounded down borrows a pixel from the ascent.
   */
  function metrics(fontKey, size) {
    const f = get(fontKey)
    let asc = Math.round(f.asc * size)
    let desc = Math.round(f.desc * size)
    if (desc < f.desc * size && asc >= 1) {
      desc++
      asc--
    }
    return { ascent: asc, descent: desc, normal: asc + desc + Math.round(f.gap * size) }
  }

  /** Baseline offset from the top of a line box `lineHeight` tall (CSS half-leading). */
  function baselineIn(fontKey, size, lineHeight) {
    const { ascent, descent } = metrics(fontKey, size)
    return ascent + Math.floor((lu(lineHeight) - (ascent + descent)) / 2)
  }

  /** One line cut with an ellipsis to fit `maxWidth`, the way text-overflow: ellipsis does. */
  function fit(fontKey, text, size, maxWidth, opts) {
    const full = run(fontKey, text, size, opts)
    if (full.advance <= maxWidth + 1e-3) return full
    const chars = [...text]
    const cut = (n) => run(fontKey, `${chars.slice(0, n).join('').trimEnd()}…`, size, opts)
    // Binary search: shaping is the cost, and a long string would otherwise be O(n^2).
    let lo = 0
    let hi = chars.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (cut(mid).advance <= maxWidth + 1e-3) lo = mid
      else hi = mid - 1
    }
    return cut(lo)
  }

  /**
   * Greedy word wrap into lines no wider than `maxWidth`, clamped to `maxLines` (the last shown
   * line gets an ellipsis when text was cut, like -webkit-line-clamp). A word wider than a whole
   * line breaks between characters, like CSS overflow-wrap: anywhere.
   * @returns {{ words: { text: string, run: any, x: number }[], width: number }[]}
   */
  function wrap(fontKey, text, size, maxWidth, { letterSpacing = 0, maxLines = Infinity } = {}) {
    const opts = { letterSpacing }
    const space = run(fontKey, ' ', size, opts).advance
    const lines = [{ words: [], width: 0 }]
    for (const word of text.split(/\s+/).filter(Boolean).flatMap((w) => breakWord(fontKey, w, size, maxWidth, opts))) {
      const r = run(fontKey, word, size, opts)
      const line = lines[lines.length - 1]
      if (line.words.length && line.width + space + r.advance > maxWidth + 1e-6) {
        lines.push({ words: [{ text: word, run: r, x: 0 }], width: r.advance })
      } else {
        const x = line.words.length ? line.width + space : 0
        line.words.push({ text: word, run: r, x })
        line.width = x + r.advance
      }
    }
    if (lines.length > maxLines) {
      const shown = lines.slice(0, maxLines)
      const last = shown[maxLines - 1]
      const lastWord = last.words[last.words.length - 1]
      const room = maxWidth - lastWord.x
      lastWord.run = fit(fontKey, `${lastWord.text}…`, size, room, opts)
      last.width = lastWord.x + lastWord.run.advance
      return shown
    }
    return lines
  }

  /** `word` as is when it fits `maxWidth`, else split into the longest pieces that do (at least one character each). */
  function breakWord(fontKey, word, size, maxWidth, opts) {
    if (run(fontKey, word, size, opts).advance <= maxWidth + 1e-6) return [word]
    const chars = [...word]
    const pieces = []
    let start = 0
    while (start < chars.length) {
      let lo = start + 1
      let hi = chars.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (run(fontKey, chars.slice(start, mid).join(''), size, opts).advance <= maxWidth + 1e-6) lo = mid
        else hi = mid - 1
      }
      pieces.push(chars.slice(start, lo).join(''))
      start = lo
    }
    return pieces
  }

  return { run, metrics, baselineIn, fit, wrap, has: (key) => key in fonts }
}
