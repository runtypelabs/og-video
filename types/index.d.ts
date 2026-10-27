// Public types for streaming-og-video. The source is JavaScript; these describe its API.

/** An ogfx path command buffer: 0 x y move, 1 x y line, 2 x1 y1 x y quad, 3 x1 y1 x2 y2 x y cubic, 4 close. */
export type Cmds = number[]
/** '#rrggbb', '#rgb', 'rgb(r, g, b)' or 0xrrggbb. */
export type Color = string | number
/** A 2D affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number]

export interface Path { readonly id: number }
/** A rasterized, premultiplied bitmap at frame position (x, y), w x h pixels. */
export interface Sprite { readonly id: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface GridEffect { readonly spec: GridSpec }
/** A dot-matrix field from ctx.dots(). */
export interface DotField { readonly id: number; readonly count: number }
/**
 * A grid of palette-indexed cells, from ctx.cells(). Fill `index` (cols x rows, row-major; 0 is
 * transparent, i picks palette[i]) before each g.cells(). `step` is the pitch in frame px.
 */
export interface CellGrid { readonly cols: number; readonly rows: number; readonly step: number; readonly index: Uint8Array }

/** A gradient stop: [offset 0..1, color, alpha?]. */
export type Stop = [number, Color] | [number, Color, number]
export type Gradient =
  | { type: 'linear'; from: [number, number]; to: [number, number]; stops: Stop[] }
  | { type: 'radial'; center: [number, number]; radius: number; stops: Stop[] }
/** A solid colour or a gradient (see linear(), radial()). Gradient coordinates are in path units. */
export type Paint = Color | Gradient
export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'overlay'

/**
 * A mask: a sprite whose alpha (or luma x alpha) gates what is drawn, placed by its own
 * transform, optionally inverted. A bare Sprite means { sprite, mode: 'alpha' }.
 */
export type Mask = Sprite | { sprite: Sprite; transform?: Matrix; mode?: 'alpha' | 'luma'; invert?: boolean }

export interface SpriteLayer {
  cmds: Cmds
  color: Paint
  alpha?: number
  evenodd?: boolean
  blend?: BlendMode
}

export interface DotOptions {
  /** Region to sample [x, y, w, h] (frame px). Default: the source sprite's bounds. */
  box?: [number, number, number, number]
  /** Cell size in px. Default 6. */
  pitch?: number
  /** Dot size in px. Default pitch / 2. */
  size?: number
  round?: boolean
  /** Cells whose coverage is below this are dropped. Default 0.04. */
  min?: number
  /** Coverage -> value exponent. Default 1. */
  gamma?: number
  seed?: number
  /**
   * Reveal threshold in [0, 1] per dot (default: `random`). `u`, `v` are the cell's position in
   * the box (0..1), `value` its coverage, `color` its source colour.
   */
  order?(dot: { x: number; y: number; u: number; v: number; value: number; color: number }, random: number): number
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
  wrap(font: string, text: string, size: number, maxWidth: number, opts?: { letterSpacing?: number; maxLines?: number; breakWords?: boolean }): {
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
  /** A white coverage sprite of a shape, for use as a mask. */
  mask(cmds: Cmds, opts?: { margin?: number; evenodd?: boolean }): Sprite | null
  /** Cuts a sprite to a shape (frame coordinates) in place, or away from it with `invert`. */
  clip(sprite: Sprite | null, cmds: Cmds, opts?: { invert?: boolean; evenodd?: boolean }): Sprite | null
  /** A drop shadow or glow: the sprite's alpha, grown by `spread`, blurred, in `color`. Same position; offset it with a transform. */
  shadow(sprite: Sprite | null, opts?: { blur?: number; color?: Color; opacity?: number; spread?: number }): Sprite | null
  /**
   * An image param (fetched before setup), decoded and fitted into the box: 'cover' crops to fill,
   * 'contain' fits inside, 'fill' stretches; `position` aligns the crop. Null when it could not be
   * fetched or decoded, in which case the render is not cached.
   */
  image(src: string | undefined, box: { x?: number; y?: number; w: number; h: number; fit?: 'cover' | 'contain' | 'fill'; position?: [number, number]; radius?: number }): Sprite | null
  /** A dot-matrix (halftone) of a sprite or layers, for g.dots(). */
  dots(source: Sprite | SpriteLayer[] | null, opts?: DotOptions): DotField | null
  /**
   * A cell grid for effects recomputed every frame (an ordered dither, say). Cells snap to whole
   * output pixels: `pitch` and `size` (frame px) round at the render scale.
   */
  cells(opts: { x?: number; y?: number; w?: number; h?: number; pitch?: number; size?: number; palette: Color[] }): CellGrid
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
  /** Live vector fill: solid or gradient paint, clipped to a rectangle and/or masked. */
  fill(path: Path | null, paint: Paint, opts?: { alpha?: number; transform?: Matrix; clip?: [number, number, number, number]; mask?: Mask; blend?: BlendMode; evenodd?: boolean }): void
  /**
   * Composites a sprite. `blur` is a Gaussian sigma in px (applied before the transform);
   * `transform` maps the sprite's frame coordinates (bilinear; whole-pixel translations copy).
   */
  draw(sprite: Sprite | null, opts?: { opacity?: number; blur?: number; clip?: [number, number, number, number]; transform?: Matrix; blend?: BlendMode; mask?: Mask }): void
  grid(effect: GridEffect, opts: { radius: number; opacity?: number; scale?: number; x?: number; y?: number }): void
  /**
   * Draws a dot field revealed to `progress` (0..1): each dot appears once progress passes its
   * threshold, fading (or growing) in over `softness`. `reverse` uses 1 - threshold (for
   * dissolving out in the same sweep direction). `color` overrides the dots' source colours.
   */
  dots(field: DotField | null, opts?: { progress?: number; softness?: number; opacity?: number; grow?: boolean; color?: Color; reverse?: boolean }): void
  /** Draws a cell grid as its `index` stands now: each nonzero cell a solid square. */
  cells(grid: CellGrid | null): void
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
  /** Layout width: scenes draw in these units. Videos render at 0.8 of it (960 by default; see DEFAULT_SCALE). Multiple of 16. Default 1200. */
  width?: number
  /** Layout height. Videos render at 0.8 of it (504 by default). Even. Default 630. */
  height?: number
  /** Default 30. */
  fps?: number
  /** Default 210 (7 s at 30 fps). */
  frames?: number
  /** x264 quantizer, 10-40. Default 20; dense motion of fine detail can go to ~23-26. */
  qp?: number
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
  /** Image URLs to fetch before setup besides p.image params (fixed artwork, say). */
  images?(params: P): string[]
  setup(ctx: SetupContext, params: P): Scene<any>
}

export interface Scenario<P = any> extends Required<Omit<ScenarioDefinition<P>, 'video' | 'prefix' | 'images'>> {
  images?(params: P): string[]
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
  /** An http(s) URL or base64 data:image (png, jpeg, webp) URI; fetched and decoded for ctx.image. */
  image<O extends FieldOpts<string> & { max?: number }>(opts?: O): Field<Opt<string, O>>
  array<T, O extends FieldOpts<T[]> & { max?: number; min?: number }>(item: Field<T>, opts?: O): Field<Opt<T[], O>>
  object<S extends Record<string, Field<any>>, O extends FieldOpts<any>>(
    shape: S,
    opts?: O,
  ): Field<Opt<{ [K in keyof S]: S[K] extends Field<infer T> ? T : never }, O>> & { shape: S }
}
export function validate<T>(schema: StandardSchema<T>, value: unknown): Promise<T>
/** Every p.image value in `value`, in schema order. */
export function imageUrls(schema: unknown, value: unknown): string[]
export interface FieldDescription {
  kind: 'string' | 'int' | 'number' | 'bool' | 'enum' | 'color' | 'image' | 'array' | 'object'
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
/** m * n: apply n, then m. */
export function multiply(m: Matrix, n: Matrix): Matrix
/** Rotate (degrees) and scale around `origin` (frame px), then move by (x, y). */
export function pose(opts?: { x?: number; y?: number; rotate?: number; scale?: number | [number, number]; origin?: [number, number] }): Matrix
export function linear(x0: number, y0: number, x1: number, y1: number, stops: Stop[]): Gradient
export function radial(cx: number, cy: number, r: number, stops: Stop[]): Gradient

// ---- physics (precompute in setup, play back per frame)

export interface Body {
  x: number
  y: number
  /** Radians. */
  angle: number
  vx: number
  vy: number
  /** Angular velocity, rad/s. */
  w: number
  readonly hw: number
  readonly hh: number
  /** At rest: exactly still and treated as static until hit, unsupported, or woken. */
  asleep: boolean
  data?: any
}
export interface World {
  readonly bodies: Body[]
  readonly time: number
  /** A box w x h centred on (x, y). density 0 makes it static. */
  box(o: { x: number; y: number; w: number; h: number; angle?: number; vx?: number; vy?: number; spin?: number; density?: number; friction?: number; data?: any }): Body
  step(dt: number): void
  wake(): void
  remove(body: Body): void
}
/** A deterministic 2D rigid-body world of boxes (Box2D-Lite style). Units: px, s; y down. */
export function createWorld(opts?: { gravity?: number; iterations?: number; sleepSpeed?: number; sleepTime?: number }): World
export function lu(n: number): number
export function pixelText(text: string): { cells: [number, number][]; cols: number; text: string }
export const ENGINE_VERSION: string
/** Output pixels per scene pixel unless an engine says otherwise: 0.8, so 1200x630 scenes render at 960x504. */
export const DEFAULT_SCALE: number
