// The share page (`/:scenario`): Open Graph and Twitter tags pointing at the video and its poster,
// plus a player, so pasting the page's URL into iMessage, Slack or X previews the video.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * Open Graph + Twitter meta tags for a video.
 * @param {{ page: string, video: string, image: string, width: number, height: number, title?: string, description?: string, siteName?: string }} o
 */
export function ogTags(o) {
  const tags = [
    ['og:type', 'video.other'],
    ['og:url', o.page],
    o.siteName && ['og:site_name', o.siteName],
    o.title && ['og:title', o.title],
    o.description && ['og:description', o.description],
    ['og:image', o.image],
    ['og:image:secure_url', o.image],
    ['og:image:type', 'image/png'],
    ['og:image:width', o.width],
    ['og:image:height', o.height],
    ['og:video', o.video],
    ['og:video:url', o.video],
    ['og:video:secure_url', o.video],
    ['og:video:type', 'video/mp4'],
    ['og:video:width', o.width],
    ['og:video:height', o.height],
  ].filter(Boolean)
  const twitter = [
    ['twitter:card', 'summary_large_image'],
    o.title && ['twitter:title', o.title],
    o.description && ['twitter:description', o.description],
    ['twitter:image', o.image],
  ].filter(Boolean)
  return [
    ...tags.map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`),
    ...twitter.map(([k, v]) => `<meta name="${k}" content="${esc(v)}">`),
  ].join('\n')
}

/** A minimal page: the tags, the video, and nothing else. */
export function sharePage(o) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title ?? o.siteName ?? 'Video')}</title>
${ogTags(o)}
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0c; font: 14px/1.5 system-ui, sans-serif; color: #a0a0a0; }
  main { width: min(100% - 32px, ${o.width}px); }
  video { width: 100%; height: auto; aspect-ratio: ${o.width} / ${o.height}; border-radius: 12px; background: #111; display: block; }
  p { margin: 12px 0 0; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
<video src="${esc(o.video)}" poster="${esc(o.image)}" autoplay muted playsinline loop controls></video>
<p><a href="${esc(o.video)}">MP4</a> · <a href="${esc(o.image)}">Poster</a>${o.footer ? ` · ${o.footer}` : ''}</p>
</main>
</body>
</html>`
}
