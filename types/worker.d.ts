import type { Scenario, FontSource } from './index.js'
import type { ImageOptions } from './node.js'

export interface RenderEvent {
  type: 'video' | 'poster' | 'page' | 'json' | 'write'
  scenario: string
  method: string
  status: number
  /** Where the bytes came from: this location's cache, R2, or a fresh render. */
  cache?: 'edge' | 'r2' | 'miss' | 'crawler'
  /** How the params were given. */
  source?: 'inline' | 'stored' | 'named'
  /** Content id of the params. */
  cid?: string
  /** For renders: where the prefix came from. */
  prefix?: 'memory' | 'r2' | 'built'
  range: boolean
  bytes?: number
  /** Frames encoded by the live tail. */
  frames?: number
  /** True when load made the tail skip frames (such renders are not cached). */
  degraded?: boolean
  /** Image params that could not be fetched (such renders are not cached). */
  missingImages?: number
  /** Renders queued or running in this isolate when this one started. */
  queued?: number
  /** 'av1' for the AV1 variant. */
  codec?: 'av1'
  /** AV1 misses: a background render was started, one was already running, or the rate limit said no. */
  av1?: 'started' | 'pending' | 'limited'
  /** Wall time in ms as Workers measure it (advances on I/O only). */
  ms?: number
  error?: string
  start: number
}

export interface StateStore {
  get(env: any, ctx: ExecutionContext, scenario: string, id: string, opts?: { mutable?: boolean }): Promise<{ params: any; cid: string } | null>
  put(env: any, scenario: string, id: string, value: { params: any; cid: string }): Promise<void>
}

export type Av1Fps = 24 | 25 | 30 | 48 | 50 | 60 | 90 | 120

export interface Av1Options {
  /**
   * Frame rate of the AV1 variant (the scenario is retimed to it), or a function of the scenario.
   * Default 120. At the edge a 7 s card costs roughly 2-12 s of CPU at 120 fps, and full-frame
   * motion (gallery, falling-words) more than the 30 s a background render gets: give those 60 or less.
   */
  fps?: Av1Fps | ((scenario: Scenario) => Av1Fps)
  /** libaom realtime cpu-used, 7-12. Default 10. */
  speed?: number
  /** Constant-quality level, 0-63 (lower is better and bigger). Default 30. */
  cq?: number
  /** Screen-content tools (palette, intra block copy). Default true. */
  screen?: boolean
  /**
   * On a cache miss: 'fallback' (default) redirects to the H.264 video and renders AV1 in the
   * background for the next viewer; 'render' renders it in the request. A request with
   * `Prefer: wait` always renders in the request.
   */
  miss?: 'fallback' | 'render'
}

export interface HandlerOptions {
  scenarios: Scenario[]
  /** R2 bucket binding name for rendered videos, posters and prefixes. Without it only the edge cache is used. */
  bucket?: string
  /** Stored params (POST/PUT, /:scenario/:id). */
  store?: StateStore
  /** Secret binding name: HMAC key for &sig= and the bearer token for writes. */
  secret?: string
  /** 'required' (default when a secret is set) rejects unsigned inline params. */
  signatures?: 'required' | 'off'
  /** 'public' lets anyone POST content-addressed params (rate limited); names always need the token. */
  writes?: 'token' | 'public'
  /** Rate limiting binding name, applied per IP to renders (cache misses) and public writes. */
  rateLimit?: string
  /** Use the Cache API in front of R2. Default true. */
  edgeCache?: boolean
  /** Cache-Control for cached responses. Default 'public, max-age=3600'. */
  cacheControl?: string
  /** Prefixes kept in isolate memory. Default 32. */
  prefixMemory?: number
  /** Live tails rendered at full frame rate before frames are skipped under load. Default 3. */
  tailsAtFullRate?: number
  /** Extra font sources by built-in name. */
  fonts?: Record<string, FontSource>
  /** Serve every route under this prefix (e.g. '/v1') and use it in links. Default: none. */
  basePath?: string
  /** With basePath, also serve the unprefixed routes. Default: false. */
  legacyPaths?: boolean
  /** Fetching image params: allowlist, size and count caps, cache budgets, custom fetch. */
  images?: ImageOptions
  /**
   * Serve an AV1 variant at /:scenario.av1.mp4 (and /:scenario/:id.av1.mp4): rendered whole,
   * not streamed, and cached under its own keys. The .mp4 URL and og:video stay H.264. Default off.
   */
  av1?: boolean | Av1Options
  siteName?: string
  /** Custom share page HTML. `av1`, `av1Codec`, `av1Fps` and `fps` are set when `av1` is on. */
  page?(o: { page: string; video: string; image: string; width: number; height: number; title?: string; description?: string; siteName?: string; scenario: Scenario; params: any; av1?: string; av1Codec?: string; av1Fps?: number; fps?: number }): string
  /** Response for '/'. */
  home?(request: Request, env: any, ctx: ExecutionContext): Response | Promise<Response>
  notFound?(request: Request, env: any, ctx: ExecutionContext): Response | Promise<Response>
  /** Called once per request (after streaming finishes for live renders). */
  onEvent?(event: RenderEvent, context: { request: Request; env: any; ctx: ExecutionContext }): void | Promise<void>
}

export function createHandler(options: HandlerOptions): { fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> }
export function videoUrl(origin: string, scenario: Scenario, params: unknown, opts?: { secret?: string; basePath?: string }): Promise<{ video: string; image: string; page: string; av1: string }>
export function kvStore(bindings: { kv?: string; r2?: string }): StateStore
export function isName(id: string): boolean
export function ogTags(o: { page: string; video: string; image: string; width: number; height: number; title?: string; description?: string; siteName?: string }): string
export function sharePage(o: { page: string; video: string; image: string; width: number; height: number; title?: string; description?: string; siteName?: string; footer?: string; av1?: string; av1Codec?: string; av1Fps?: number }): string
/** AV1 then H.264 <source> elements ('' without `av1`). */
export function videoSources(o: { video: string; av1?: string; av1Codec?: string }): string
/** Inline script dropping the AV1 source unless MediaCapabilities reports smooth, power-efficient decoding ('' without `av1`). */
export function av1Script(o: { av1?: string; av1Codec?: string; av1Fps?: number; width: number; height: number }): string
/** The codec string an AV1 encode at this size and rate gets, e.g. av01.0.09M.08. */
export function av1Codec(width: number, height: number, fps: number): string
export const AV1_DEFAULTS: { fps: number; speed: number; cq: number; screen: boolean }
/** User agents of link unfurlers and crawlers: they are redirected from AV1 to H.264. */
export const CRAWLER: RegExp
