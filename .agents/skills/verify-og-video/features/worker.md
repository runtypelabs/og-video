# Worker routes

`createHandler` serves scenarios over HTTP: streamed MP4s, posters, JSON and share pages, plus
byte ranges for iOS. Users meet this as og.video URLs, or as their own deployment of
`examples/worker`.

## Sub-features

- `mp4`: `GET /<id>.mp4?<params>`. On a miss it streams. On a repeat it's a cache hit
  (`x-sogv-cache`).
- `png`: `GET /<id>.png?<params>` serves the poster.
- `json`: `GET /<id>.json?<params>` returns the resolved params, the content id (`cid`) and
  links.
- `page`: `GET /<id>?<params>` returns a share page with `og:video` and `og:image` tags.
- `range`: a `Range:` request gets a 206 from the same bytes.
- `store`: `POST /<id>` with a JSON body returns a content-id URL.

## How to get to it (user POV)

- `npm run dev` (wrangler dev on `examples/worker/wrangler.jsonc`, which serves title-card and
  diagram), then open `http://127.0.0.1:<port>/title-card?title=Hi`.

## Driving it with wrangler dev and curl

Preconditions:

- The port is free. Start the Worker yourself and record its pid:
  `npx wrangler dev -c examples/worker/wrangler.jsonc --port 8799 --ip 127.0.0.1 > .verify/wrangler.log 2>&1 & echo $! > .verify/wrangler.pid`
- It's ready when `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8799/title-card.json`
  prints `200` (5-20 s).

- **JSON.** `curl -s 'http://127.0.0.1:8799/title-card.json?title=Hi'` returns
  `"scenario": "title-card"`, a `cid`, and `params.title` set to `"Hi"`.
- **MP4 matches sogv.** Run
  `curl -s -o .verify/scratch/w.mp4 'http://127.0.0.1:8799/title-card.mp4?title=Hi'`, then
  `node src/node/cli.js render title-card --params '{"title":"Hi"}' -o .verify/scratch/c.mp4`.
  `cmp` on the two prints nothing: the Worker and the CLI produce the same bytes.
- **Cache.** Repeat the request with `-D -`. It returns `x-sogv-cache: edge` and an
  `x-sogv-id` equal to the `cid`.
- **Range.** `curl -s -o /dev/null -w '%{http_code} %{size_download}' -H 'Range: bytes=0-999' '…/title-card.mp4?title=Hi'`
  prints `206 1000`.
- **Poster.** `curl -s -o /dev/null -w '%{http_code} %{content_type}' '…/title-card.png?title=Hi'`
  prints `200 image/png`.
- **Teardown.** Run `kill $(cat .verify/wrangler.pid)`, then
  `lsof -iTCP:8799 -sTCP:LISTEN` should print nothing.

## Gotchas

- The example only serves `title-card` and `diagram`. Other ids return 404 there.
- The example turns signatures off. With a secret set, inline params need `&sig=`
  (`videoUrl(..., { secret })`).
- wrangler dev simulates R2, KV and the cache locally under `.wrangler/`. Delete that directory
  to test a cold miss again.
- Never kill wrangler by name: the user may have their own `wrangler dev` running. Kill the pid
  you recorded.
