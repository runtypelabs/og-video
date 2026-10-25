import type { Scenario, FontSource } from './index.js'
import type { ImageOptions } from './node.js'

export interface RenderEvent {
  type: 'video' | 'poster' | 'page' | 'json' | 'write'
  scenario: string
  method: string
  status: number
  /** Where the bytes came from: this location's cache, R2, or a fresh render. */
  cache?: 'edge' | 'r2' | 'miss'
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
  /** Wall time in ms as Workers measure it (advances on I/O only). */
  ms?: number
  error?: string
  start: number
}

export interface StateStore {
  get(env: any, ctx: ExecutionContext, scenario: string, id: string, opts?: { mutable?: boolean }): Promise<{ params: any; cid: string } | null>
  put(env: any, scenario: string, id: string, value: { params: any; cid: string }): Promise<void>
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
  /** Render at about this fraction of each scenario's layout size, composited natively. Default 0.8 (1200x630 -> 960x504); 1 renders at the layout size. */
  scale?: number
  /** Extra font sources by built-in name. */
  fonts?: Record<string, FontSource>
  /** Serve every route under this prefix (e.g. '/v1') and use it in links. Default: none. */
  basePath?: string
  /** With basePath, also serve the unprefixed routes. Default: false. */
  legacyPaths?: boolean
  /** Fetching image params: allowlist, size and count caps, cache budgets, custom fetch. */
  images?: ImageOptions
  siteName?: string
  /** Custom share page HTML. */
  page?(o: { page: string; video: string; image: string; width: number; height: number; title?: string; description?: string; siteName?: string; scenario: Scenario; params: any }): string
  /** Response for '/'. */
  home?(request: Request, env: any, ctx: ExecutionContext): Response | Promise<Response>
  notFound?(request: Request, env: any, ctx: ExecutionContext): Response | Promise<Response>
  /** Called once per request (after streaming finishes for live renders). */
  onEvent?(event: RenderEvent, context: { request: Request; env: any; ctx: ExecutionContext }): void | Promise<void>
}

export function createHandler(options: HandlerOptions): { fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> }
export function videoUrl(origin: string, scenario: Scenario, params: unknown, opts?: { secret?: string; basePath?: string }): Promise<{ video: string; image: string; page: string }>
export function kvStore(bindings: { kv?: string; r2?: string }): StateStore
export function isName(id: string): boolean
export function ogTags(o: { page: string; video: string; image: string; width: number; height: number; title?: string; description?: string; siteName?: string }): string
export function sharePage(o: { page: string; video: string; image: string; width: number; height: number; title?: string; description?: string; siteName?: string; footer?: string }): string
