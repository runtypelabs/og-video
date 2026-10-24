#!/usr/bin/env node
// Upload a run's evidence as GitHub attachments and upsert one comment on the PR.
//
//   node post.mjs --pr <n> --run .verify/runs/<id> [--notes notes.md] [--dry-run]
//
// WHY user attachments: they are what `gh pr comment --attach` (gh >= 2.99) uploads, with the
// token `gh auth login` already holds. MP4s render as inline players, images inline, and nothing
// lands in the repo (no evidence branch, release or tag on a public npm library). `--attach` only
// creates a comment or edits your *last* one, so this script makes the same upload request gh
// makes (POST uploads.github.com/user-attachments/assets, see cli/cli internal/attachments) and
// then PATCHes the marker comment by id. If that request ever stops working, the documented
// fallback is in SKILL.md ("If uploads fail").
//
// The comment starts with MARKER and is rewritten on every run: newest run on top, the previous
// few folded under "Earlier runs", so a PR carries one comment however often you push.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    pr: { type: 'string' },
    run: { type: 'string' },
    notes: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})
if (!args.pr || !args.run) {
  console.error('usage: post.mjs --pr <n> --run <run-dir> [--notes notes.md] [--dry-run]')
  process.exit(2)
}

const MARKER = '<!-- verify-og-video -->'
const RUN_START = '<!-- verify-og-video:run -->'
const RUN_END = '<!-- /verify-og-video:run -->'
const KEEP_EARLIER = 3

const run = path.resolve(args.run)
const report = JSON.parse(readFileSync(path.join(run, 'report.json'), 'utf8'))
const notes = args.notes ? readFileSync(args.notes, 'utf8').trim() : ''
const gh = (a, input) => execFileSync('gh', a, { input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).toString()
const api = (route, { method = 'GET', body } = {}) => JSON.parse(gh(['api', '-X', method, route, ...(body ? ['--input', '-'] : [])], body && JSON.stringify(body)) || 'null')
const repo = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner
const repoId = api(`repos/${repo}`).id
const pr = JSON.parse(gh(['pr', 'view', args.pr, '--json', 'headRefOid,url']))

// ---------------------------------------------------------------- uploads (cached per run)

const TYPES = { '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4' }
const cacheFile = path.join(run, 'uploads.json')
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
let uploads = 0

/** Uploads a file of the run once and returns its github.com/user-attachments URL. */
function url(rel) {
  const file = path.join(run, rel)
  const bytes = readFileSync(file)
  const sum = createHash('sha256').update(bytes).digest('hex')
  if (cache[rel]?.sha256 === sum) return cache[rel].url
  if (args['dry-run']) return `./${rel}`
  const name = `${report.run}-${rel.replace(/\//g, '-')}`
  const q = new URLSearchParams({ name, content_type: TYPES[path.extname(rel)], repository_id: String(repoId) })
  for (let attempt = 1; ; attempt++) {
    try {
      const res = JSON.parse(gh(['api', '-X', 'POST', `https://uploads.github.com/user-attachments/assets?${q}`, '-H', 'Content-Type: application/octet-stream', '--input', file]))
      if (!res?.url) throw new Error(`no url in ${JSON.stringify(res)}`)
      cache[rel] = { sha256: sum, url: res.url }
      writeFileSync(cacheFile, JSON.stringify(cache, null, 2))
      uploads++
      return res.url
    } catch (err) {
      if (attempt >= 3) throw new Error(`upload of ${rel} failed: ${err.stderr?.toString() || err.message}`)
      execFileSync('sleep', [String(attempt * 5)])
    }
  }
}

// ---------------------------------------------------------------- comment body

const short = (s) => (s ? s.slice(0, 7) : '?')
const kb = (n) => (n == null ? '–' : `${(n / 1024).toFixed(0)} KB`)
const ms = (b) => (b?.median == null ? '–' : `${b.median} ms`)
const arrow = (a, b, f) => (a == null ? f(b) : b == null ? f(a) : `${f(a)} → ${f(b)}`)
const img = (rel, alt, width) => `<img src="${url(rel)}" alt="${alt}" width="${width}">`
const video = (rel) => `\n${url(rel)}\n` // alone in its paragraph, so GitHub renders a player
const at = (e, i) => `frame ${i} (${(i / e.video.fps).toFixed(2)} s)`
const sheetCaption = (e) => `Contact sheet: ${e.sheetFrames.map((i) => `${(i / e.video.fps).toFixed(1)} s`).join(', ')}.`

const items = report.items
const failed = report.failures
const statusCell = (i) =>
  i.status === 'changed'
    ? `**changed** from ${at(i.head, i.firstDiff)}, ${i.framesChanged}/${i.head.video.frames} frames`
    : i.status === 'identical'
      ? 'identical bytes'
      : `**${i.status}**`
const checksCell = (i) => (i.invariants.length ? `FAIL (${i.invariants.length})` : 'pass')

const summary = [
  '| Scenario | Params | Output | Size | `sogv bench` median | Invariants |',
  '| --- | --- | --- | --- | --- | --- |',
  ...items.map(
    (i) => `| \`${i.id}\` | ${i.set} | ${statusCell(i)} | ${arrow(i.base?.bytes, i.head?.bytes, kb)} | ${arrow(i.base?.bench, i.head?.bench, ms)} | ${checksCell(i)} |`,
  ),
].join('\n')

const changedSections = items
  .filter((i) => i.status === 'changed' || i.status === 'added')
  .map((i) => {
    const k = i.key
    const lines = [`#### \`${i.id}\` · ${i.set} · ${i.status}`]
    if (i.status === 'changed') {
      lines.push(
        `First difference at ${at(i.head, i.firstDiff)}, base left, head right. Cache key: ${i.cacheKey}.`,
        '',
        img(`compare/${k}.frame.png`, `${k} base and head at frame ${i.firstDiff}`, 800),
        '',
        `| base \`${short(report.base.rev)}\` | head \`${short(report.head.rev)}\` |`,
        '| --- | --- |',
        `| ${img(`base/${k}.sheet.png`, `${k} base contact sheet`, 400)} | ${img(`head/${k}.sheet.png`, `${k} head contact sheet`, 400)} |`,
        `| ${img(`base/${k}.png`, `${k} base poster`, 400)} | ${img(`head/${k}.png`, `${k} head poster`, 400)} |`,
        '',
        `<sub>${sheetCaption(i.head)} Second row: the poster (og:image).</sub>`,
        '',
        `<details><summary>Difference of the contact sheets (x4)</summary>\n\n${img(`compare/${k}.diff.png`, `${k} sheet difference`, 800)}\n\n</details>`,
        '',
        'Head:',
        video(`head/${k}.mp4`),
        `<details><summary>Base video</summary>\n${video(`base/${k}.mp4`)}\n</details>`,
      )
    } else {
      lines.push(img(`head/${k}.sheet.png`, `${k} contact sheet`, 800), '', `<sub>${sheetCaption(i.head)}</sub>`, '', img(`head/${k}.png`, `${k} poster`, 400), video(`head/${k}.mp4`))
    }
    if (i.invariants.length) lines.push('', ...i.invariants.map((x) => `- ${x}`))
    return lines.join('\n')
  })

// The AV1 variant (run.sh --av1), when the run has one.
const av1File = path.join(run, 'av1', 'manifest.json')
const av1 = existsSync(av1File) ? JSON.parse(readFileSync(av1File, 'utf8')).entries : []
const av1Section = av1.length
  ? [
      '#### AV1 variant (head)',
      'Rendered whole at the frame rate shown, next to H.264 retimed to the same frame rate on the same machine (best of 2). Default params.',
      [
        '| Scenario | fps | Frames (encoded) | H.264 ms | AV1 ms | AV1 / H.264 | H.264 size | AV1 size |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...av1.map((e) =>
          e.error
            ? `| \`${e.id}\` | ${e.fps} | **error** | | | | | |`
            : `| \`${e.id}\` | ${e.fps} | ${e.frames} (${e.encoded}) | ${e.h264.ms} | ${e.av1.ms} | ${(e.av1.ms / e.h264.ms).toFixed(1)}x | ${kb(e.h264.bytes)} | ${kb(e.av1.bytes)} |`,
        ),
      ].join('\n'),
      ...av1
        .filter((e) => !e.error)
        .map((e) =>
          [
            `<details><summary><code>${e.id}</code> · ${e.codec} · ${e.fps} fps</summary>\n`,
            e.ffprobe ? `ffprobe: \`${e.ffprobe}\`` : '',
            e.avfoundation ? `AVFoundation: \`${e.avfoundation}\`` : '',
            video(`av1/${e.file}`),
            '</details>',
          ]
            .filter(Boolean)
            .join('\n\n'),
        ),
      ...av1.filter((e) => e.error).map((e) => `\`${e.id}\`:\n\`\`\`\n${e.error}\n\`\`\``),
    ].join('\n\n')
  : ''

const unchanged = items.filter((i) => i.status === 'identical')
const unchangedSection = unchanged.length
  ? [
      `#### Unchanged (${unchanged.length})`,
      'Byte-identical at base and head. Renders are deterministic, so these look exactly as before.',
      ...unchanged.map(
        (i) =>
          `<details><summary><code>${i.id}</code> · ${i.set} · sha256 <code>${i.head.sha256.slice(0, 12)}</code></summary>\n\n${img(`head/${i.key}.sheet.png`, `${i.key} contact sheet`, 800)}\n\n<sub>${sheetCaption(i.head)}</sub>\n\n${img(`head/${i.key}.png`, `${i.key} poster`, 400)}\n${video(`head/${i.key}.mp4`)}\n</details>`,
      ),
    ].join('\n\n')
  : ''

const otherSections = items
  .filter((i) => i.status === 'error' || i.status === 'removed')
  .map((i) => `#### \`${i.id}\` · ${i.set} · ${i.status}\n\n${[i.head?.error, i.base?.error].filter(Boolean).map((e) => `\`\`\`\n${e}\n\`\`\``).join('\n')}`)

const a = report.affected
const affectedLine = a
  ? a.scenarios.length
    ? `**Affected:** ${a.all ? 'all scenarios' : a.scenarios.map((s) => `\`${s.id}\``).join(', ')}, because of ${[...new Set(a.scenarios.flatMap((s) => s.reasons))].slice(0, 6).join('; ')}.`
    : '**Affected:** no scenario. Nothing in this diff reaches rendered bytes.'
  : ''
const warnings = (a?.warnings ?? []).map((w) => `> [!WARNING]\n> ${w}`).join('\n\n')
const engineLine =
  report.head.engineVersion == null
    ? 'nothing rendered'
    : report.base.engineVersion === report.head.engineVersion
      ? `ENGINE_VERSION ${report.head.engineVersion}`
      : `ENGINE_VERSION ${report.base.engineVersion} → ${report.head.engineVersion}`
const invariantsLine = failed.length
  ? `**Invariants: ${failed.length} failed.**\n\n${failed.map((f) => `- ${f}`).join('\n')}`
  : items.length
    ? '**Invariants: all pass.** Two renders are byte-identical (in-process and `sogv render` in a fresh process), the prefix is the start of each file, posters are PNGs of the frame size, and every changed render either has a new content id or a bumped version.'
    : ''

const runBody = [
  RUN_START,
  `### Run \`${report.run}\` · base \`${short(report.base.rev)}\` → head \`${short(report.head.rev)}\` · ${engineLine}`,
  pr.headRefOid === report.head.rev ? '' : `> [!CAUTION]\n> This evidence is for \`${short(report.head.rev)}\`, but the PR head is now \`${short(pr.headRefOid)}\`. Rerun the skill.`,
  notes,
  affectedLine,
  warnings,
  invariantsLine,
  items.length ? summary : '',
  items.length ? `<sub>Size is the whole MP4. Bench is \`sogv bench --runs ${items[0].head?.bench?.runs ?? items[0].base?.bench?.runs ?? '?'}\` on the machine that ran this, base then head, so compare them with each other, not with other runs.</sub>` : '',
  ...changedSections,
  ...otherSections,
  av1Section,
  unchangedSection,
  RUN_END,
]
  .filter(Boolean)
  .join('\n\n')

const comments = args['dry-run'] ? [] : JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${args.pr}/comments`])).flat()
const previous = comments.find((c) => c.body?.startsWith(MARKER))
const earlier = previous ? (previous.body.match(new RegExp(`${RUN_START}[\\s\\S]*?${RUN_END}`, 'g')) ?? []).slice(0, KEEP_EARLIER) : []
let body = [
  MARKER,
  '## Render evidence',
  '<sub>Posted by the `verify-og-video` skill (`.agents/skills/verify-og-video`). Videos and images are GitHub attachments.</sub>',
  runBody,
  earlier.length ? `<details><summary>Earlier runs (${earlier.length})</summary>\n\n${earlier.join('\n\n')}\n\n</details>` : '',
]
  .filter(Boolean)
  .join('\n\n')
if (body.length > 65_000) body = body.replace(/<details><summary>Earlier runs[\s\S]*$/, '<sub>Earlier runs dropped: the comment hit GitHub\'s size limit.</sub>')

writeFileSync(path.join(run, 'comment.md'), body)
if (args['dry-run']) {
  console.log(body)
  process.exit(0)
}
const posted = previous
  ? api(`repos/${repo}/issues/comments/${previous.id}`, { method: 'PATCH', body: { body } })
  : api(`repos/${repo}/issues/${args.pr}/comments`, { method: 'POST', body: { body } })
console.error(`${uploads} uploaded, ${Object.keys(cache).length - uploads} reused`)
console.log(posted.html_url)
