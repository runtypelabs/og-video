// Public types for streaming-og-video. The source is JavaScript; these describe its API.

/** An ogfx path command buffer: 0 x y move, 1 x y line, 2 x1 y1 x y quad, 3 x1 y1 x2 y2 x y cubic, 4 close. */
export type Cmds = number[]
/** '#rrggbb', '#rgb', 'rgb(r, g, b)' or 0xrrggbb. */
export type Color = string | number
/** A 2D affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number]

export interface Path { readonly id: number }
export interface Sprite { readonly id: number }
export interface GridEffect { readonly spec: GridSpec }

export interface SpriteLayer {
  cmds: Cmds
  color: Color
  alpha?: number
  evenodd?: boolean
}

export interface GridSpec {
  /** Cache key: the mask is kept across renders while this is unchanged. */
  key: string
  /** The shape to tile (usually many rounded cells). */
  cells: Cmds
  /** Maps `cells` units to frame pixels. */
  transform: Matrix
  /** Reveal centre in frame pixels. */
  center: [number, number]
  /** Frame-pixel rectangle the mask covers (it may overhang the frame). */
  canvas: { x: number; y: number; w: number; h: number }
  /** Gray levels 0-255. */
  background?: number
  cell?: number
}

export interface TextRun {
  advance: number
  glyphCount: number
  rightOf(index: number): number
  /** Outlines with the run's origin at (x, baseline); `only` keeps one glyph. */
  cmds(x: number, baseline: number, only?: number): Cmds
}

export interface TextEngine {
  run(font: string, text: string, size: number, opts?: { letterSpacing?: number; features?: Record<string, boolean> }): TextRun
  metrics(font: string, size: number): { ascent: number; descent: number; normal: number }
  baselineIn(font: string, size: number, lineHeight: number): number
  fit(font: string, text: string, size: number, maxWidth: number, opts?: { letterSpacing?: number }): TextRun
  wrap(font: string, text: string, size: number, maxWidth: number, opts?: { letterSpacing?: number; maxLines?: number }): {
    words: { text: string; run: TextRun; x: number }[]
    width: number
  }[]
  has(font: string): boolean
}

/** What setup() gets: everything is rasterized or shaped once here. */
export interface SetupContext {
  width: number
  height: number
  fps: number
  frames: number
  text: TextEngine
  path(cmds: Cmds): Path | null
  sprite(layers: (SpriteLayer | null | false | undefined)[], opts?: { margin?: number }): Sprite | null
  /** A sprite whose premultiplied RGBA pixels `paint` writes (gradients, noise, images). */
  bitmap(x: number, y: number, w: number, h: number, paint: (rgba: Uint8Array, w: number, h: number) => void): Sprite
  grid(spec: GridSpec): GridEffect
}

/** What draw() gets, once per changed frame. */
export interface Frame {
  width: number
  height: number
  /**
   * A cached backdrop. Calls stack: the deepest layer whose key (and every earlier key) is
   * unchanged is restored with a memcpy; layers after it are repainted. Must come before overlays.
   */
  layer(key: unknown, paint: (g: Frame) => void): void
  /** Repaints the whole frame; outside a layer it must be the first call. */
  clear(color: Color): void
  fill(path: Path | null, color: Color, opts?: { alpha?: number; transform?: Matrix }): void
  draw(sprite: Sprite | null, opts?: { opacity?: number; blur?: number; clip?: [number, number, number, number] }): void
  grid(effect: GridEffect, opts: { radius: number; opacity?: number; scale?: number; x?: number; y?: number }): void
}

export interface Scene<S = unknown> {
  /** Pure: the same i always gives an equal S, starting from any i. Equal states skip the frame. */
  state(i: number): S
  /** Paints S. Called only when the state changed. */
  draw(g: Frame, state: S): void
  dispose?(): void
}

export interface StandardSchema<T = unknown> {
  readonly '~standard': {
    version: 1
    vendor: string
    validate(value: unknown): { value: T; issues?: undefined } | { issues: readonly { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }[] } | Promise<any>
  }
}

export interface VideoSpec {
  /** Multiple of 16. Default 1200. */
  width?: number
  /** Even. Default 630. */
  height?: number
  /** Default 30. */
  fps?: number
  /** Default 210 (7 s at 30 fps). */
  frames?: number
}

export type FontSource = string | ArrayBuffer | Uint8Array | (() => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>)

export interface ScenarioDefinition<P> {
  /** URL-safe id: /<id>.mp4. */
  id: string
  /** Bump to invalidate every cached render of this scenario. */
  version?: number
  video?: VideoSpec
  /** Validates and bounds params (p.object(...) or any Standard Schema). */
  params: StandardSchema<P>
  /**
   * Frames [0, frames) must depend only on key(params): they are encoded once per key and sent
   * before anything renders. Check with `sogv prefix`.
   */
  prefix?: { frames: number; key?(params: P): string }
  /** Title and description for the share page's Open Graph tags. */
  meta?(params: P): { title?: string; description?: string }
  /** Poster frame for og:image: 'last' (default) or a frame index. */
  poster?: 'last' | number
  /** Font name -> source. 'regular' and 'semibold' (Inter) are always there unless overridden. */
  fonts?: Record<string, FontSource>
  setup(ctx: SetupContext, params: P): Scene<any>
}

export interface Scenario<P = any> extends Required<Omit<ScenarioDefinition<P>, 'video' | 'prefix'>> {
  video: Required<VideoSpec>
  prefix: { frames: number; key(params: P): string }
}

export function defineScenario<P>(def: ScenarioDefinition<P>): Scenario<P>

// ---- params schema

export class ParamError extends Error {
  path: (string | number)[]
  reason: string
}

interface Field<T> extends StandardSchema<T> {
  parse(value: unknown, path?: (string | number)[]): T
}
interface FieldOpts<T> {
  default?: T | (() => T)
  optional?: boolean
}
type Opt<T, O> = O extends { optional: true } ? T | undefined : T

export const p: {
  string<O extends FieldOpts<string> & { max?: number; min?: number; pattern?: RegExp }>(opts?: O): Field<Opt<string, O>>
  int<O extends FieldOpts<number> & { min?: number; max?: number }>(opts?: O): Field<Opt<number, O>>
  number<O extends FieldOpts<number> & { min?: number; max?: number }>(opts?: O): Field<Opt<number, O>>
  bool<O extends FieldOpts<boolean>>(opts?: O): Field<Opt<boolean, O>>
  enum<V extends string, O extends FieldOpts<V>>(values: readonly V[], opts?: O): Field<Opt<V, O>>
  color<O extends FieldOpts<string>>(opts?: O): Field<Opt<string, O>>
  array<T, O extends FieldOpts<T[]> & { max?: number; min?: number }>(item: Field<T>, opts?: O): Field<Opt<T[], O>>
  object<S extends Record<string, Field<any>>, O extends FieldOpts<any>>(
    shape: S,
    opts?: O,
  ): Field<Opt<{ [K in keyof S]: S[K] extends Field<infer T> ? T : never }, O>> & { shape: S }
}
export function validate<T>(schema: StandardSchema<T>, value: unknown): Promise<T>
export interface FieldDescription {
  kind: 'string' | 'int' | 'number' | 'bool' | 'enum' | 'color' | 'array' | 'object'
  default?: unknown
  optional?: boolean
  min?: number
  max?: number
  pattern?: string
  values?: string[]
  item?: FieldDescription
  shape?: Record<string, FieldDescription>
}
/** A JSON description of a p.* schema, for forms and docs. */
export function describe(schema: unknown): FieldDescription

// ---- params on the wire

export function canonical(value: unknown): string
export function contentId(scenarioId: string, params: unknown): Promise<string>
export function pack(params: unknown): Promise<string>
export function unpack(s: string, maxBytes?: number): Promise<any>
export function sign(secret: string, scenarioId: string, params: unknown): Promise<string>
export function verify(secret: string, scenarioId: string, params: unknown, sig: string | null): Promise<boolean>
export function rawParams(url: URL, schema?: unknown): Promise<Record<string, unknown>>

// ---- drawing helpers

export function rgb(color: Color): number
export function rrect(x: number, y: number, w: number, h: number, r: number): Cmds
export function rect(x0: number, y0: number, x1: number, y1: number): Cmds
export function ellipse(cx: number, cy: number, rx: number, ry?: number): Cmds
export function transform(cmds: Cmds, k: number, tx?: number, ty?: number): Cmds
export function bounds(cmds: Cmds): { x0: number; y0: number; x1: number; y1: number }
export function stateKey(value: unknown): string
export function lu(n: number): number
export function pixelText(text: string): { cells: [number, number][]; cols: number; text: string }
export const ENGINE_VERSION: string
