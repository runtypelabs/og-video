import type { Scenario, FontSource } from './index.js'

export interface Prefix {
  bytes: Uint8Array
  frames: number
  avcC: Uint8Array
  timescale: number
  trackId: number
  nextSeq: number
}

export interface ImageOptions {
  /** Fetches an image URL (default: global fetch with a timeout; on Workers, cached for a day). */
  fetch?(url: string): Promise<Response | Uint8Array | ArrayBuffer>
  /** Hosts to allow; return false to refuse a URL. Default: any http(s). */
  allow?(url: URL): boolean
  /** Largest image accepted, in bytes. Default 5 MB. */
  maxBytes?: number
  /** Most images per render; more count as missing. Default 24. */
  maxImages?: number
  /** Fetch timeout in ms. Default 8000. */
  timeout?: number
  /** Per-isolate cache budgets (encoded bytes, and decoded sprites), each. Default 16 MB. */
  cacheBytes?: number
}

/** Fetched image params for one render; `missing` failed (do not cache such a render). */
export interface Assets {
  images: Map<string, Uint8Array | null>
  missing: string[]
}

export interface Engine {
  exclusive<T>(job: (instances: { compositor: any; encoder: any }) => Promise<T>): Promise<T>
  frameStep(): number
  readonly queued: number
  /** Fetches the images a render needs (p.image params and scenario.images()). */
  assets(scenario: Scenario, params: any): Promise<Assets>
  prefix(scenario: Scenario, params: any, opts?: { assets?: Assets }): Promise<Prefix>
  tail(scenario: Scenario, params: any, prefix: Prefix, opts: { write(bytes: Uint8Array): void; frameStep?: () => number; yieldToNetwork?: () => Promise<void>; assets?: Assets }): Promise<{ encoded: number; skipped: number }>
  file(scenario: Scenario, params: any, prefix?: Prefix, opts?: { assets?: Assets }): Promise<Uint8Array>
  poster(scenario: Scenario, params: any, frame?: number, opts?: { assets?: Assets }): Promise<Uint8Array>
  frames(scenario: Scenario, params: any, onFrame: (i: number, rgba: Uint8Array) => void | Promise<void>, opts?: { from?: number; to?: number; assets?: Assets }): Promise<number>
}

export function createNodeEngine(options?: { tailsAtFullRate?: number; images?: ImageOptions }): Promise<Engine>
export function createEngine(options: {
  modules: { ogfx: WebAssembly.Module; x264: WebAssembly.Module }
  fonts: Record<string, FontSource>
  tailsAtFullRate?: number
  images?: ImageOptions
}): Engine
export function parseParams<P>(scenario: Scenario<P>, raw?: unknown): Promise<P>
export function concat(parts: Uint8Array[]): Uint8Array
export const ENGINE_VERSION: string
