import type { Scenario, FontSource } from './index.js'

export interface Prefix {
  bytes: Uint8Array
  frames: number
  avcC: Uint8Array
  timescale: number
  trackId: number
  nextSeq: number
}

export interface Engine {
  exclusive<T>(job: (instances: { compositor: any; encoder: any }) => Promise<T>): Promise<T>
  frameStep(): number
  readonly queued: number
  prefix(scenario: Scenario, params: any): Promise<Prefix>
  tail(scenario: Scenario, params: any, prefix: Prefix, opts: { write(bytes: Uint8Array): void; frameStep?: () => number; yieldToNetwork?: () => Promise<void> }): Promise<{ encoded: number; skipped: number }>
  file(scenario: Scenario, params: any, prefix?: Prefix): Promise<Uint8Array>
  poster(scenario: Scenario, params: any, frame?: number): Promise<Uint8Array>
  frames(scenario: Scenario, params: any, onFrame: (i: number, rgba: Uint8Array) => void | Promise<void>, opts?: { from?: number; to?: number }): Promise<number>
}

export function createNodeEngine(options?: { tailsAtFullRate?: number }): Promise<Engine>
export function createEngine(options: {
  modules: { ogfx: WebAssembly.Module; x264: WebAssembly.Module }
  fonts: Record<string, FontSource>
  tailsAtFullRate?: number
}): Engine
export function parseParams<P>(scenario: Scenario<P>, raw?: unknown): Promise<P>
export function concat(parts: Uint8Array[]): Uint8Array
export const ENGINE_VERSION: string
