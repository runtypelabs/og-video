//! ogfx: a retained-mode compositor for streaming-og-video scenes.
//!
//! Re-rasterizing the whole SVG every frame (what resvg does) spends almost all of its time on the
//! same pixels: hundreds of grid cells that only change by a radial fade, text that only changes
//! by opacity or blur. This module rasterizes each shape once with tiny-skia (resvg's rasterizer)
//! and then builds every frame from cached layers:
//!
//! * the grid is one coverage mask; the reveal multiplies it by the gradient ramp per pixel;
//! * during the logo flip the grid is resampled from a mip pyramid (bilinear from the level that
//!   matches the scale) instead of re-filling ~2,000 rounded rectangles every frame;
//! * text and the badge are premultiplied sprites, blurred with three box passes when animating;
//! * the finished RGBA frame is converted to I420 here, so the encoder never sees RGBA.
//!
//! The ABI is plain `extern "C"` (no wasm-bindgen) so it loads in Workers as a bare module.

#![allow(non_snake_case)]

use core::arch::wasm32::*;
use tiny_skia::{
    Color, FillRule, GradientStop, LinearGradient, Mask, Paint, Path, PathBuilder, Pixmap, Point, RadialGradient, SpreadMode,
    Transform,
};

/// Layer slots available to `layer_save` / `layer_restore`.
const LAYERS: usize = 8;

struct Sprite {
    x: i32,
    y: i32,
    pix: Pixmap,
}

struct Grid {
    /// Canvas origin in frame pixels (the grid overhangs the frame a little).
    ox: i32,
    oy: i32,
    w: usize,
    h: usize,
    cov: Vec<u8>,
    dist: Vec<f32>,
    /// Reveal centre in frame pixels.
    cx: f32,
    cy: f32,
    /// Gray levels (0..255) of the background and of a fully revealed cell.
    bg: f32,
    cell: f32,
    /// Coverage x the ramp at the baked radius, as a mip pyramid. Each level keeps a one-texel
    /// transparent border so bilinear taps never need bounds checks.
    mips: Vec<Mip>,
}

struct Mip {
    w: usize,
    h: usize,
    /// (w + 2) x (h + 2), border included.
    px: Vec<u8>,
}

struct State {
    /// Frame size in pixels; the width is a multiple of 16 and the height is even.
    w: usize,
    h: usize,
    mbw: usize,
    mbh: usize,
    paths: Vec<Path>,
    sprites: Vec<Sprite>,
    frame: Pixmap,
    /// Saved frames, one per layer slot (see layer_save).
    layers: Vec<Vec<u8>>,
    /// Macroblocks drawn over (above the restored base) this frame and last frame.
    touched: [Vec<u8>; 2],
    /// The base under the overlays changed this frame, so every macroblock must be checked.
    full: bool,
    marking: bool,
    /// Whether `yuv` holds the previous frame (so unchanged macroblocks can be detected).
    prev_valid: bool,
    /// One macroblock converted to I420 (256 Y + 64 U + 64 V), compared before it is stored.
    mb_tmp: [u8; 384],
    mb_info: Vec<u8>,
    /// A blurred copy of the sprite being drawn.
    scratch: Vec<u8>,
    blur: BlurBufs,
    /// Mask values and sampled source pixels for the draw in progress.
    mask_buf: Vec<u8>,
    row_buf: Vec<u32>,
    /// Frame-size mask for clipped or masked fills (allocated on first use).
    fill_mask: Option<Mask>,
    dots: Vec<Dots>,
    /// The most recently decoded image (see image_decode).
    image: Option<Image>,
    yuv: Vec<u8>,
    grid: Option<Grid>,
}

static mut STATE: Option<State> = None;

#[allow(static_mut_refs)]
fn st() -> &'static mut State {
    unsafe {
        STATE.get_or_insert_with(|| new_state(1200, 630))
    }
}

fn new_state(w: usize, h: usize) -> State {
    let (mbw, mbh) = ((w + 15) / 16, (h + 15) / 16);
    State {
            w,
            h,
            mbw,
            mbh,
            paths: Vec::new(),
            sprites: Vec::new(),
            frame: Pixmap::new(w as u32, h as u32).unwrap(),
            layers: vec![Vec::new(); LAYERS],
            touched: [vec![0; mbw * mbh], vec![0; mbw * mbh]],
            full: true,
            marking: false,
            prev_valid: false,
            mb_tmp: [0; 384],
            mb_info: vec![0; mbw * mbh],
            scratch: Vec::new(),
            blur: BlurBufs::default(),
            mask_buf: Vec::new(),
            row_buf: Vec::new(),
            fill_mask: None,
            dots: Vec::new(),
            image: None,
            yuv: vec![0; w * h * 3 / 2],
            grid: None,
    }
}

/// Sets the frame size (width a multiple of 16, height even). Changing it drops all state,
/// including the grid; calling it again with the current size is free.
#[no_mangle]
pub extern "C" fn init(w: u32, h: u32) -> i32 {
    if w == 0 || h == 0 || w % 16 != 0 || h % 2 != 0 { return -1; }
    let s = st();
    if s.w != w as usize || s.h != h as usize {
        unsafe { STATE = Some(new_state(w as usize, h as usize)); }
    }
    0
}

/// 8-byte aligned, so JS can view the block as a Float32Array.
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u64>::with_capacity((n + 7) / 8);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p as *mut u64, 0, (n + 7) / 8));
}

/// Drops per-render state (paths, sprites, saved layers). The grid (mask, distances, mips) is
/// kept, since consecutive renders of one scenario usually share it; `grid_ready` says whether
/// one exists and the caller decides whether to set it up again.
#[no_mangle]
pub extern "C" fn reset() {
    let s = st();
    s.paths.clear();
    s.sprites.clear();
    s.dots.clear();
    s.image = None;
    for l in s.layers.iter_mut() { l.clear(); }
    s.prev_valid = false;
}

#[no_mangle]
pub extern "C" fn grid_ready() -> i32 {
    st().grid.is_some() as i32
}

/// Command buffer: 0 x y = move, 1 x y = line, 2 x1 y1 x y = quad, 3 x1 y1 x2 y2 x y = cubic, 4 = close.
#[no_mangle]
pub unsafe extern "C" fn path_new(ptr: *const f32, len: usize) -> i32 {
    let c = std::slice::from_raw_parts(ptr, len);
    let mut pb = PathBuilder::new();
    let mut i = 0;
    while i < len {
        match c[i] as u32 {
            0 => { pb.move_to(c[i + 1], c[i + 2]); i += 3 }
            1 => { pb.line_to(c[i + 1], c[i + 2]); i += 3 }
            2 => { pb.quad_to(c[i + 1], c[i + 2], c[i + 3], c[i + 4]); i += 5 }
            3 => { pb.cubic_to(c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5], c[i + 6]); i += 7 }
            _ => { pb.close(); i += 1 }
        }
    }
    let s = st();
    match pb.finish() {
        Some(p) => { s.paths.push(p); (s.paths.len() - 1) as i32 }
        None => -1,
    }
}

fn tf(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) -> Transform {
    Transform::from_row(a, b, c, d, e, f)
}

fn paint(rgb: u32, alpha: f32) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(Color::from_rgba8((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, (alpha.clamp(0.0, 1.0) * 255.0 + 0.5) as u8));
    p.anti_alias = true;
    p
}

/// A transparent sprite covering frame pixels [x, x+w) x [y, y+h).
#[no_mangle]
pub extern "C" fn sprite_new(x: i32, y: i32, w: u32, h: u32) -> i32 {
    let s = st();
    s.sprites.push(Sprite { x, y, pix: Pixmap::new(w.max(1), h.max(1)).unwrap() });
    (s.sprites.len() - 1) as i32
}

/// Fills a path into a sprite. The transform maps path units to frame pixels.
#[no_mangle]
pub extern "C" fn sprite_fill(id: i32, path: i32, rgb: u32, alpha: f32, evenodd: i32, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {
    let s = st();
    let p = &s.paths[path as usize];
    let sp = &mut s.sprites[id as usize];
    let t = tf(a, b, c, d, e, f).post_translate(-sp.x as f32, -sp.y as f32);
    let rule = if evenodd != 0 { FillRule::EvenOdd } else { FillRule::Winding };
    sp.pix.fill_path(p, &paint(rgb, alpha), rule, t, None);
}

/// Live vector fill straight into the frame (small, transformed shapes: pixels, letters, caret).
#[no_mangle]
pub extern "C" fn fill(path: i32, rgb: u32, alpha: f32, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {
    if alpha <= 0.0 { return; }
    let s = st();
    let t = tf(a, b, c, d, e, f);
    let bb = s.paths[path as usize].bounds();
    let xs = [bb.left() * a + bb.top() * c + e, bb.right() * a + bb.top() * c + e, bb.left() * a + bb.bottom() * c + e, bb.right() * a + bb.bottom() * c + e];
    let ys = [bb.left() * b + bb.top() * d + f, bb.right() * b + bb.top() * d + f, bb.left() * b + bb.bottom() * d + f, bb.right() * b + bb.bottom() * d + f];
    let (x0, x1) = (xs.iter().cloned().fold(f32::MAX, f32::min), xs.iter().cloned().fold(f32::MIN, f32::max));
    let (y0, y1) = (ys.iter().cloned().fold(f32::MAX, f32::min), ys.iter().cloned().fold(f32::MIN, f32::max));
    mark_rect(s, x0, y0, x1, y1);
    let p = &s.paths[path as usize];
    s.frame.fill_path(p, &paint(rgb, alpha), FillRule::Winding, t, None);
}

#[no_mangle]
pub extern "C" fn clear(rgb: u32) {
    st().frame.fill(Color::from_rgba8((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8, 255));
}

#[no_mangle]
pub extern "C" fn layer_save(slot: usize) {
    if slot >= LAYERS { return; }
    let s = st();
    // Allocated on first use: a live tail never touches the grid layer.
    s.layers[slot].clear();
    s.layers[slot].extend_from_slice(s.frame.data());
}

#[no_mangle]
pub extern "C" fn layer_restore(slot: usize) {
    let s = st();
    if slot >= LAYERS || s.layers[slot].is_empty() { return; }
    s.frame.data_mut().copy_from_slice(&s.layers[slot]);
}

/// Starts a frame. `full` = the base layer differs from last frame's; otherwise only macroblocks
/// covered by overlays (this frame's or last frame's) can have changed.
#[no_mangle]
pub extern "C" fn frame_begin(full: i32) {
    let s = st();
    s.touched.swap(0, 1);
    s.touched[0].fill(0);
    s.full = full != 0;
    s.marking = false;
}

/// Marks this frame as having a changed base, so to_i420 checks every macroblock.
#[no_mangle]
pub extern "C" fn frame_full() {
    st().full = true;
}

/// While on, sprite_draw and fill record the macroblocks they cover.
#[no_mangle]
pub extern "C" fn mark(on: i32) {
    st().marking = on != 0;
}

fn mark_rect(s: &mut State, x0: f32, y0: f32, x1: f32, y1: f32) {
    if !s.marking { return; }
    let (mbw, mbh) = (s.mbw, s.mbh);
    let mx0 = ((x0.floor() - 1.0).max(0.0) as usize / 16).min(mbw);
    let my0 = ((y0.floor() - 1.0).max(0.0) as usize / 16).min(mbh);
    let mx1 = (((x1.ceil() + 1.0).max(0.0) as usize + 15) / 16).min(mbw);
    let my1 = (((y1.ceil() + 1.0).max(0.0) as usize + 15) / 16).min(mbh);
    for my in my0..my1 {
        s.touched[0][my * mbw + mx0..my * mbw + mx1.max(mx0)].fill(1);
    }
}

// ------------------------------------------------------------------ grid

/// Rasterizes the grid path once into a coverage mask over [ox, ox+w) x [oy, oy+h) and records
/// each pixel's distance (frame pixels) from the reveal centre (cx, cy).
#[no_mangle]
pub extern "C" fn grid_setup(path: i32, ox: i32, oy: i32, w: u32, h: u32, cx: f32, cy: f32, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32, bg: u32, cell: u32) {
    let s = st();
    let (w, h) = (w as usize, h as usize);
    let mut m = Mask::new(w as u32, h as u32).unwrap();
    m.fill_path(&s.paths[path as usize], FillRule::Winding, true, tf(a, b, c, d, e, f).post_translate(-ox as f32, -oy as f32));
    let mut dist = vec![0f32; w * h];
    for y in 0..h {
        // Gradients are evaluated at pixel centres.
        let dy = (y as f32 + oy as f32 + 0.5) - cy;
        for x in 0..w {
            let dx = (x as f32 + ox as f32 + 0.5) - cx;
            dist[y * w + x] = (dx * dx + dy * dy).sqrt();
        }
    }
    s.grid = Some(Grid { ox, oy, w, h, cov: m.data().to_vec(), dist, cx, cy, bg: bg as f32, cell: cell as f32, mips: Vec::new() });
}

/// The template's radial gradient alpha: stops (0, 1), (0.55, 0.55), (1, 0), padded.
#[inline]
fn ramp(t: f32) -> f32 {
    if t < 0.55 { 1.0 - t * (0.45 / 0.55) } else if t < 1.0 { (1.0 - t) * (0.55 / 0.45) } else { 0.0 }
}

/// Writes gray level `v` (0..255) as an opaque RGBA pixel.
#[inline(always)]
fn gray(v: f32) -> u32 {
    let v = (v + 0.5) as u32;
    0xff00_0000 | v * 0x0001_0101
}

#[inline(always)]
fn rows_u32(data: &mut [u8]) -> &mut [u32] {
    // Pixmap storage is 4-byte aligned (tiny-skia allocates it as premultiplied u32 colours).
    let (pre, mid, post) = unsafe { data.align_to_mut::<u32>() };
    debug_assert!(pre.is_empty() && post.is_empty());
    mid
}

/// Clears to the background and paints the grid at reveal radius `r` (frame px) and `opacity`,
/// with the stage untransformed. Only spans inside the reveal circle are touched, and the ramp is
/// branch-free (compare-and-select, not f32.min, which has NaN rules) so the loop vectorizes.
#[no_mangle]
pub extern "C" fn grid_reveal(r: f32, opacity: f32) {
    let s = st();
    let (W, H) = (s.w, s.h);
    let g = s.grid.as_ref().unwrap();
    let (BG, CELL) = (g.bg, g.cell);
    s.frame.fill(Color::from_rgba8(BG as u8, BG as u8, BG as u8, 255));
    let g = s.grid.as_ref().unwrap();
    let out = rows_u32(s.frame.data_mut());
    let inv = 1.0 / r.max(1e-6);
    let k = (CELL - BG) * opacity / 255.0;
    let (cx, cy) = (g.cx, g.cy);
    let y0 = ((cy - r).floor().max(0.0) as usize).max(g.oy.max(0) as usize);
    let y1 = ((cy + r).ceil().min(H as f32) as usize).min((g.oy + g.h as i32).max(0) as usize);
    for y in y0..y1 {
        let dy = y as f32 + 0.5 - cy;
        let half = (r * r - dy * dy).max(0.0).sqrt();
        let x0 = ((cx - half).floor().max(0.0) as usize).max(g.ox.max(0) as usize);
        let x1 = ((cx + half).ceil().min(W as f32) as usize).min((g.ox + g.w as i32).max(0) as usize);
        if x1 <= x0 { continue; }
        let n = x1 - x0;
        let gi = (y as i32 - g.oy) as usize * g.w + (x0 as i32 - g.ox) as usize;
        let cov = &g.cov[gi..gi + n];
        let dist = &g.dist[gi..gi + n];
        let row = &mut out[y * W + x0..y * W + x1];
        for i in 0..n {
            let t = dist[i] * inv;
            let a = 1.0 - t * (0.45 / 0.55);
            let b = (1.0 - t) * (0.55 / 0.45);
            let m = if a < b { a } else { b };
            let m = if m > 0.0 { m } else { 0.0 };
            row[i] = gray(BG + k * cov[i] as f32 * m);
        }
    }
}

/// Bakes coverage x ramp(radius r) into a mip pyramid for `grid_scaled`.
#[no_mangle]
pub extern "C" fn grid_bake(r: f32) {
    let s = st();
    let g = s.grid.as_mut().unwrap();
    let inv = 1.0 / r;
    let (w, h) = (g.w, g.h);
    let mut px = vec![0u8; (w + 2) * (h + 2)];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            px[(y + 1) * (w + 2) + x + 1] = (g.cov[i] as f32 * ramp(g.dist[i] * inv) + 0.5) as u8;
        }
    }
    let mut mips = vec![Mip { w, h, px }];
    while mips.len() < 6 {
        let p = mips.last().unwrap();
        let (nw, nh) = ((p.w + 1) / 2, (p.h + 1) / 2);
        let mut px = vec![0u8; (nw + 2) * (nh + 2)];
        let at = |x: usize, y: usize| -> u32 {
            if x < p.w && y < p.h { p.px[(y + 1) * (p.w + 2) + x + 1] as u32 } else { 0 }
        };
        for y in 0..nh {
            for x in 0..nw {
                let v = at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1);
                px[(y + 1) * (nw + 2) + x + 1] = ((v + 2) / 4) as u8;
            }
        }
        mips.push(Mip { w: nw, h: nh, px });
    }
    g.mips = mips;
}

/// Clears to the background and paints the baked grid under the stage transform (uniform scale
/// `k`, then translate (tx, ty)): bilinear taps into the mip level whose texels are closest to
/// one frame pixel, with per-column and per-row tap positions computed once per frame.
#[no_mangle]
pub extern "C" fn grid_scaled(k: f32, tx: f32, ty: f32, opacity: f32) {
    let s = st();
    let (W, H) = (s.w, s.h);
    let g = s.grid.as_ref().unwrap();
    let (BG, CELL) = (g.bg, g.cell);
    s.frame.fill(Color::from_rgba8(BG as u8, BG as u8, BG as u8, 255));
    if opacity <= 0.0 { return; }
    let g = s.grid.as_ref().unwrap();
    let level = ((1.0 / k).log2().floor().max(0.0) as usize).min(g.mips.len() - 1);
    let m = &g.mips[level];
    let unit = (1usize << level) as f32;
    // Frame pixel centre -> texel coordinate in this level, border included (+1), centred (-0.5).
    let tex = |p: f32, t: f32, o: i32| ((p + 0.5 - t) / k - o as f32) / unit + 0.5;
    let taps = |n: usize, t: f32, o: i32, size: usize| -> Vec<(usize, f32)> {
        (0..n)
            .map(|p| {
                let u = tex(p as f32, t, o);
                if u < 0.0 || u >= (size + 1) as f32 { (usize::MAX, 0.0) } else { (u as usize, u.fract()) }
            })
            .collect()
    };
    let cols = taps(W, tx, g.ox, m.w);
    let rows = taps(H, ty, g.oy, m.h);
    let scale = (CELL - BG) * opacity / 255.0;
    let stride = m.w + 2;
    let out = rows_u32(s.frame.data_mut());
    let first = cols.iter().position(|c| c.0 != usize::MAX).unwrap_or(W);
    let last = cols.iter().rposition(|c| c.0 != usize::MAX).map_or(0, |i| i + 1);
    for (y, &(ty0, fy)) in rows.iter().enumerate() {
        if ty0 == usize::MAX { continue; }
        let r0 = &m.px[ty0 * stride..(ty0 + 1) * stride];
        let r1 = &m.px[(ty0 + 1) * stride..(ty0 + 2) * stride];
        let row = &mut out[y * W..(y + 1) * W];
        for x in first..last {
            let (tx0, fx) = cols[x];
            let a = r0[tx0] as f32 + (r0[tx0 + 1] as f32 - r0[tx0] as f32) * fx;
            let b = r1[tx0] as f32 + (r1[tx0 + 1] as f32 - r1[tx0] as f32) * fx;
            row[x] = gray(BG + scale * (a + (b - a) * fy));
        }
    }
}

// ------------------------------------------------------------------ blur

/// Gaussian blur of premultiplied RGBA in place; samples outside the buffer are transparent.
///
/// Large sigmas run on a downsampled copy: the sprite is box-averaged by `f` (a power of two
/// chosen so the blur at the reduced size stays between 2 and 4 texels), blurred there with three
/// box passes (SVG feGaussianBlur's rule), and upsampled bilinearly. The box filter and the
/// bilinear upsample are themselves a blur of about f/2 px, which the reduced sigma subtracts. So
/// a full-frame blur costs about the same at any sigma: a downsample, a cheap blur on 1/f² of the
/// pixels, and an upsample.
fn blur(px: &mut [u8], w: usize, h: usize, sigma: f32, b: &mut BlurBufs) {
    if sigma <= 0.05 || w == 0 || h == 0 { return; }
    let sigma = sigma.min(250.0);
    let mut k = 0u32;
    while sigma / (2u32 << k) as f32 >= 1.5 && k < 5 { k += 1; }
    let f = 1usize << k;
    let sc = if f == 1 { sigma } else { ((sigma / f as f32).powi(2) - 0.25).max(0.25).sqrt() };
    let (sw, sh) = ((w + f - 1) >> k, (h + f - 1) >> k);
    // Downsample into 12.4 fixed point (value * 16), so the low-res blur keeps some precision.
    // Partial blocks at the right and bottom edges count the missing pixels as transparent.
    b.a.clear();
    if k == 0 {
        b.a.extend(px.iter().map(|&v| (v as u16) << 4));
    } else {
        b.sum.clear();
        b.sum.resize(sw * sh * 4, 0);
        for y in 0..h {
            let row = &px[y * w * 4..(y + 1) * w * 4];
            let sum = &mut b.sum[(y >> k) * sw * 4..((y >> k) + 1) * sw * 4];
            for (t, block) in sum.chunks_exact_mut(4).zip(row.chunks(f * 4)) {
                unsafe {
                    let mut acc = v128_load(t.as_ptr() as *const v128);
                    for p in block.chunks_exact(4) {
                        let v = v128_load32_zero(p.as_ptr() as *const u32);
                        acc = i32x4_add(acc, u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v)));
                    }
                    v128_store(t.as_mut_ptr() as *mut v128, acc);
                }
            }
        }
        if k == 1 {
            b.a.extend(b.sum.iter().map(|&v| (v * 4) as u16));
        } else {
            let shift = 2 * k - 4;
            let r = if shift > 0 { 1 << (shift - 1) } else { 0 };
            b.a.extend(b.sum.iter().map(|&v| ((v + r) >> shift) as u16));
        }
    }
    let d = (sc * 3.0 * (2.0 * std::f32::consts::PI).sqrt() / 4.0 + 0.5).floor() as usize;
    if d >= 1 {
        let passes: [(usize, usize); 3] = if d % 2 == 1 {
            [(d, d / 2), (d, d / 2), (d, d / 2)]
        } else {
            [(d, d / 2), (d, d / 2 - 1), (d + 1, d / 2)]
        };
        for &(size, off) in &passes { box_h16(&mut b.a, &mut b.t, sw, sh, size, off); }
        for &(size, off) in &passes { box_v16(&mut b.a, &mut b.t, &mut b.acc, sw, sh, size, off); }
    }
    if f == 1 {
        for (o, &v) in px.iter_mut().zip(b.a.iter()) { *o = ((v + 8) >> 4).min(255) as u8; }
        return;
    }
    // Back to 8-bit premultiplied pixels, then a bilinear upsample with packed lerps. Texel i is
    // centred on pixel (i + 0.5) * f; clamped at the edges.
    b.lo.clear();
    b.lo.extend(b.a.chunks_exact(4).map(|c| {
        let q = |v: u16| (((v + 8) >> 4).min(255)) as u32;
        let a = q(c[3]);
        q(c[0]).min(a) | (q(c[1]).min(a) << 8) | (q(c[2]).min(a) << 16) | (a << 24)
    }));
    let taps = |n: usize, m: usize| -> Vec<(usize, usize, u32)> {
        (0..n)
            .map(|p| {
                let u = ((p as f32 + 0.5) / f as f32 - 0.5).max(0.0);
                let i = (u as usize).min(m - 1);
                let j = (i + 1).min(m - 1);
                (i, j, ((u - i as f32) * 256.0) as u32)
            })
            .collect()
    };
    let cols = taps(w, sw);
    let rows = taps(h, sh);
    b.row.clear();
    b.row.resize(sw, 0);
    let out = rows_u32(px);
    for (y, &(r0, r1, fy)) in rows.iter().enumerate() {
        for i in 0..sw { b.row[i] = lerp_px(b.lo[r0 * sw + i], b.lo[r1 * sw + i], fy); }
        let o = &mut out[y * w..(y + 1) * w];
        for (p, &(c0, c1, fx)) in o.iter_mut().zip(cols.iter()) { *p = lerp_px(b.row[c0], b.row[c1], fx); }
    }
}

#[derive(Default)]
struct BlurBufs {
    a: Vec<u16>,
    t: Vec<u16>,
    acc: Vec<u32>,
    sum: Vec<u32>,
    lo: Vec<u32>,
    row: Vec<u32>,
}

/// 65536 / size, for dividing window sums by multiply-and-shift.
#[inline]
fn recip(size: usize) -> u32 { (65536 + size as u32 / 2) / size as u32 }

/// One horizontal box pass over 12.4 fixed-point RGBA: a running window, one pixel (four
/// channels as u32 lanes) per step.
fn box_h16(a: &mut Vec<u16>, t: &mut Vec<u16>, w: usize, h: usize, size: usize, off: usize) {
    let m = recip(size);
    t.clear();
    t.resize(a.len(), 0);
    unsafe {
        let ld = |p: *const u16| u32x4_extend_low_u16x8(v128_load64_zero(p as *const u64));
        let (mv, half) = (u32x4_splat(m), u32x4_splat(32768));
        for y in 0..h {
            let row = a.as_ptr().add(y * w * 4);
            let out = t.as_mut_ptr().add(y * w * 4);
            let mut acc = u32x4_splat(0);
            // Window for output x is source [x - off, x - off + size).
            for x in 0..(size - off - 1).min(w) { acc = i32x4_add(acc, ld(row.add(x * 4))); }
            for x in 0..w {
                let add = x + size - off - 1;
                if add < w { acc = i32x4_add(acc, ld(row.add(add * 4))); }
                let q = u32x4_shr(i32x4_add(i32x4_mul(acc, mv), half), 16);
                v128_store64_lane::<0>(u16x8_narrow_i32x4(q, q), out.add(x * 4) as *mut u64);
                if x >= off { acc = i32x4_sub(acc, ld(row.add((x - off) * 4))); }
            }
        }
    }
    std::mem::swap(a, t);
}

/// One vertical box pass: a running window down every column at once, row by row, eight
/// channels per step (window sums stay under 2^16: values are at most 4080 and windows short).
fn box_v16(a: &mut Vec<u16>, t: &mut Vec<u16>, _acc: &mut Vec<u32>, w: usize, h: usize, size: usize, off: usize) {
    if size == 1 { return; }
    let m = recip(size) as u16;
    let n = w * 4;
    t.clear();
    t.resize(a.len(), 0);
    let mut acc = vec![0u16; n + 8];
    let rows = |a: &[u16], r: usize| a.as_ptr().wrapping_add(r * n);
    unsafe {
        let mv = u16x8_splat(m);
        let half = u32x4_splat(32768);
        let step = |acc: &mut [u16], src: *const u16, add: bool| {
            let mut i = 0;
            while i + 8 <= n {
                let p = acc.as_mut_ptr().add(i) as *mut v128;
                let v = v128_load(src.add(i) as *const v128);
                v128_store(p, if add { i16x8_add(v128_load(p), v) } else { i16x8_sub(v128_load(p), v) });
                i += 8;
            }
            for j in i..n { acc[j] = if add { acc[j].wrapping_add(*src.add(j)) } else { acc[j].wrapping_sub(*src.add(j)) }; }
        };
        for r in 0..(size - off - 1).min(h) { step(&mut acc, rows(a, r), true); }
        for y in 0..h {
            let add = y + size - off - 1;
            if add < h { step(&mut acc, rows(a, add), true); }
            let o = t.as_mut_ptr().add(y * n);
            let mut i = 0;
            while i + 8 <= n {
                let v = v128_load(acc.as_ptr().add(i) as *const v128);
                let lo = u32x4_shr(i32x4_add(u32x4_extmul_low_u16x8(v, mv), half), 16);
                let hi = u32x4_shr(i32x4_add(u32x4_extmul_high_u16x8(v, mv), half), 16);
                v128_store(o.add(i) as *mut v128, u16x8_narrow_i32x4(lo, hi));
                i += 8;
            }
            for j in i..n { *o.add(j) = ((acc[j] as u32 * m as u32 + 32768) >> 16) as u16; }
            if y >= off { step(&mut acc, rows(a, y - off), false); }
        }
    }
    std::mem::swap(a, t);
}

// ------------------------------------------------------------------ draw arguments

/// Argument block for calls that take more than a handful of numbers (draw_ex, fill_ex,
/// sprite_fill_ex): JS writes floats here, then makes the call. Layout:
///
/// * draw_ex: 0 sprite, 1 opacity, 2 blur sigma, 3 blend mode;
/// * fill_ex: 0 path, 1 alpha, 2 blend mode, 3 rgb, 23 even-odd, 24 paint (0 solid, 1 linear,
///   2 radial), 25..29 gradient geometry (x0 y0 x1 y1 or cx cy r), 29 stop count, then
///   (offset, r, g, b, a) per stop from 30;
/// * both: 4..8 clip rectangle, 8..14 transform, 14 mask sprite (-1 none), 15 mask mode
///   (0 alpha, 1 luma), 16 invert, 17..23 mask transform.
static mut ARGS: [f32; 96] = [0.0; 96];
const MAX_STOPS: usize = 13;

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn args_ptr() -> *mut f32 {
    unsafe { ARGS.as_mut_ptr() }
}

#[allow(static_mut_refs)]
fn args() -> [f32; 96] {
    unsafe { ARGS }
}

/// Blend modes for sprites and fills.
const NORMAL: u32 = 0;
const ADD: u32 = 1;
const SCREEN: u32 = 2;
const MULTIPLY: u32 = 3;
const OVERLAY: u32 = 4;

fn skia_blend(mode: u32) -> tiny_skia::BlendMode {
    use tiny_skia::BlendMode as B;
    match mode { ADD => B::Plus, SCREEN => B::Screen, MULTIPLY => B::Multiply, OVERLAY => B::Overlay, _ => B::SourceOver }
}

/// An affine transform [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f.
#[derive(Clone, Copy)]
struct Affine([f32; 6]);

impl Affine {
    fn at(a: &[f32]) -> Affine { Affine([a[0], a[1], a[2], a[3], a[4], a[5]]) }
    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        let m = &self.0;
        (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
    }
    fn invert(&self) -> Option<Affine> {
        let [a, b, c, d, e, f] = self.0;
        let det = a * d - b * c;
        if det.abs() < 1e-12 { return None; }
        let i = 1.0 / det;
        Some(Affine([d * i, -b * i, -c * i, a * i, (c * f - d * e) * i, (b * e - a * f) * i]))
    }
    /// Integer translation, if that is all it is.
    fn offset(&self) -> Option<(i32, i32)> {
        let [a, b, c, d, e, f] = self.0;
        (a == 1.0 && b == 0.0 && c == 0.0 && d == 1.0 && e == e.round() && f == f.round()).then(|| (e as i32, f as i32))
    }
    /// Bounds of the rectangle [x0, x1) x [y0, y1) after the transform.
    fn bounds(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> (f32, f32, f32, f32) {
        let pts = [self.apply(x0, y0), self.apply(x1, y0), self.apply(x0, y1), self.apply(x1, y1)];
        let mut b = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for (x, y) in pts { b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y)); }
        b
    }
}

/// An integer rectangle [x0, x1) x [y0, y1) in frame pixels.
#[derive(Clone, Copy)]
struct Rect { x0: i32, y0: i32, x1: i32, y1: i32 }

impl Rect {
    fn frame(s: &State) -> Rect { Rect { x0: 0, y0: 0, x1: s.w as i32, y1: s.h as i32 } }
    fn and(self, o: Rect) -> Rect { Rect { x0: self.x0.max(o.x0), y0: self.y0.max(o.y0), x1: self.x1.min(o.x1), y1: self.y1.min(o.y1) } }
    fn empty(&self) -> bool { self.x1 <= self.x0 || self.y1 <= self.y0 }
    /// The clip rectangle at args[4..8], rounded to whole pixels.
    fn clip(a: &[f32]) -> Rect {
        let r = |v: f32| v.round().clamp(-1e6, 1e6) as i32;
        Rect { x0: r(a[4]), y0: r(a[5]), x1: r(a[6]), y1: r(a[7]) }
    }
    fn outer(b: (f32, f32, f32, f32)) -> Rect {
        let c = |v: f32| v.clamp(-1e6, 1e6);
        Rect { x0: c(b.0).floor() as i32, y0: c(b.1).floor() as i32, x1: c(b.2).ceil() as i32, y1: c(b.3).ceil() as i32 }
    }
}

// ------------------------------------------------------------------ sampling

/// Two premultiplied pixels mixed by f/256, two channels per multiply.
#[inline(always)]
fn lerp_px(a: u32, b: u32, f: u32) -> u32 {
    let g = 256 - f;
    let rb = (((a & 0x00ff_00ff) * g + (b & 0x00ff_00ff) * f) >> 8) & 0x00ff_00ff;
    let ag = (((a >> 8) & 0x00ff_00ff) * g + ((b >> 8) & 0x00ff_00ff) * f) & 0xff00_ff00;
    rb | ag
}

/// Bilinear samples of a premultiplied sprite (w x h, as u32 pixels) along one frame row: dest
/// pixel X maps to sprite texel coordinates (u0 + X du, v0 + X dv), with texel centres on
/// integers. Taps outside the sprite are transparent. Fixed point 16.16 so the row is
/// integer-only after setup.
fn sample_row(pix: &[u32], w: usize, h: usize, u0: f32, v0: f32, du: f32, dv: f32, out: &mut [u32]) {
    let fx = |v: f32| (v.clamp(-3e4, 3e4) * 65536.0) as i32;
    let (mut u, mut v) = (fx(u0), fx(v0));
    let (du, dv) = (fx(du), fx(dv));
    let (wi, hi) = (w as i32, h as i32);
    for o in out.iter_mut() {
        let (x, y) = (u >> 16, v >> 16);
        let (fu, fv) = (((u >> 8) & 255) as u32, ((v >> 8) & 255) as u32);
        *o = if x >= 0 && y >= 0 && x + 1 < wi && y + 1 < hi {
            let i = y as usize * w + x as usize;
            let (a, b, c, d) = (pix[i], pix[i + 1], pix[i + w], pix[i + w + 1]);
            // Sprites are mostly transparent (text, shapes): skip the maths for empty taps.
            if a | b | c | d == 0 { 0 } else { lerp_px(lerp_px(a, b, fu), lerp_px(c, d, fu), fv) }
        } else if x < -1 || y < -1 || x >= wi || y >= hi {
            0
        } else {
            let t = |x: i32, y: i32| if x >= 0 && y >= 0 && x < wi && y < hi { pix[y as usize * w + x as usize] } else { 0 };
            lerp_px(lerp_px(t(x, y), t(x + 1, y), fu), lerp_px(t(x, y + 1), t(x + 1, y + 1), fu), fv)
        };
        u = u.wrapping_add(du);
        v = v.wrapping_add(dv);
    }
}

fn as_u32(data: &[u8]) -> &[u32] {
    let (pre, mid, post) = unsafe { data.align_to::<u32>() };
    debug_assert!(pre.is_empty() && post.is_empty());
    mid
}

/// Where a sprite lands: its pixels (blurred or not), origin and size, and the transform.
struct Placed<'a> {
    pix: &'a [u32],
    x: i32,
    y: i32,
    w: usize,
    h: usize,
    tf: Affine,
}

impl<'a> Placed<'a> {
    /// Frame-pixel bounds of the placed sprite.
    fn bounds(&self) -> Rect {
        match self.tf.offset() {
            Some((dx, dy)) => Rect { x0: self.x + dx, y0: self.y + dy, x1: self.x + dx + self.w as i32, y1: self.y + dy + self.h as i32 },
            None => Rect::outer(self.tf.bounds(self.x as f32, self.y as f32, (self.x + self.w as i32) as f32, (self.y + self.h as i32) as f32)),
        }
    }

    /// The columns [a, b) of frame row `fy`, within [x0, x1), that can sample the sprite at all:
    /// a rotated sprite's bounding box is mostly empty.
    fn span(&self, fy: i32, x0: i32, x1: i32) -> (i32, i32) {
        if self.tf.offset().is_some() { return (x0, x1); }
        let Some(inv) = self.tf.invert() else { return (x0, x0) };
        let (px, py) = inv.apply(x0 as f32 + 0.5, fy as f32 + 0.5);
        let [a, b, ..] = inv.0;
        let (mut lo, mut hi) = (0f32, (x1 - x0) as f32);
        // Texel coordinate t0 + k * d must stay in (-1, n) for some tap to be inside.
        for (t0, d, n) in [(px - self.x as f32 - 0.5, a, self.w as f32), (py - self.y as f32 - 0.5, b, self.h as f32)] {
            if d.abs() < 1e-9 {
                if t0 <= -1.0 || t0 >= n { return (x0, x0); }
                continue;
            }
            let (k0, k1) = ((-1.0 - t0) / d, (n - t0) / d);
            lo = lo.max(k0.min(k1));
            hi = hi.min(k0.max(k1));
        }
        if hi <= lo { return (x0, x0); }
        // One pixel of slack on each side for rounding; the sampler handles the edges.
        ((x0 + lo.floor() as i32 - 1).max(x0), (x0 + hi.ceil() as i32 + 1).min(x1))
    }

    /// Fills `out` with the sprite's pixels for frame row `fy`, columns [fx0, fx0 + out.len()).
    fn row(&self, fy: i32, fx0: i32, out: &mut [u32]) {
        if let Some((dx, dy)) = self.tf.offset() {
            out.fill(0);
            let (sx, sy) = (fx0 - self.x - dx, fy - self.y - dy);
            if sy < 0 || sy as usize >= self.h { return; }
            let a = sx.max(0).min(self.w as i32);
            let b = (sx + out.len() as i32).max(0).min(self.w as i32);
            if b > a {
                let r = sy as usize * self.w;
                out[(a - sx) as usize..(b - sx) as usize].copy_from_slice(&self.pix[r + a as usize..r + b as usize]);
            }
            return;
        }
        let Some(inv) = self.tf.invert() else { out.fill(0); return };
        // Pixel centre (X + 0.5, fy + 0.5) -> frame coordinates of the untransformed sprite ->
        // texel coordinates (centres on integers).
        let (px, py) = inv.apply(fx0 as f32 + 0.5, fy as f32 + 0.5);
        let [a, b, ..] = inv.0;
        sample_row(self.pix, self.w, self.h, px - self.x as f32 - 0.5, py - self.y as f32 - 0.5, a, b, out);
    }
}

// ------------------------------------------------------------------ blending

/// dst = src * op + dst * (1 - src.a * op) on premultiplied RGBA over an opaque frame,
/// four pixels per step in wasm SIMD.
fn blend_row(dst: &mut [u8], src: &[u8], op: u16) {
    let n = dst.len() / 4;
    let mut i = 0;
    unsafe {
        let opv = u16x8_splat(op);
        let k255 = u16x8_splat(255);
        let k128 = u16x8_splat(128);
        let lanes = |s: v128, d: v128| -> v128 {
            let s = u16x8_shr(i16x8_mul(s, opv), 8);
            // Broadcast each pixel's alpha (u16 lanes 3 and 7) across its four lanes.
            let a = i8x16_shuffle::<6, 7, 6, 7, 6, 7, 6, 7, 14, 15, 14, 15, 14, 15, 14, 15>(s, s);
            let t = i16x8_add(i16x8_mul(d, i16x8_sub(k255, a)), k128);
            i16x8_add(s, u16x8_shr(i16x8_add(t, u16x8_shr(t, 8)), 8))
        };
        while i + 4 <= n {
            let sp = src.as_ptr().add(i * 4) as *const v128;
            let dp = dst.as_mut_ptr().add(i * 4) as *mut v128;
            let sv = v128_load(sp);
            if !v128_any_true(v128_and(sv, u32x4_splat(0xff00_0000))) { i += 4; continue; }
            let dv = v128_load(dp);
            let lo = lanes(u16x8_extend_low_u8x16(sv), u16x8_extend_low_u8x16(dv));
            let hi = lanes(u16x8_extend_high_u8x16(sv), u16x8_extend_high_u8x16(dv));
            v128_store(dp, u8x16_narrow_i16x8(lo, hi));
            i += 4;
        }
    }
    let op = op as u32;
    for i in i..n {
        let a = (src[i * 4 + 3] as u32 * op) >> 8;
        if a == 0 { continue; }
        for ch in 0..3 {
            let sv = (src[i * 4 + ch] as u32 * op) >> 8;
            dst[i * 4 + ch] = (sv + (dst[i * 4 + ch] as u32 * (255 - a) + 127) / 255).min(255) as u8;
        }
    }
}

/// x / 255, rounded, for x < 65536.
#[inline(always)]
fn div255(x: u32) -> u32 { (x + 128 + ((x + 128) >> 8)) >> 8 }

/// The separable blend modes over an opaque frame, from premultiplied source (W3C compositing:
/// Cr = (1 - as) Cd + as B(Cd, Cs / as)).
fn blend_mode_row(dst: &mut [u8], src: &[u8], op: u16, mode: u32) {
    let op = op as u32;
    for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
        let a = (s[3] as u32 * op) >> 8;
        if a == 0 { continue; }
        for ch in 0..3 {
            let sc = ((s[ch] as u32 * op) >> 8).min(a);
            let dc = d[ch] as u32;
            let v = match mode {
                ADD => dc + sc,
                SCREEN => sc + dc - div255(sc * dc),
                MULTIPLY => div255(sc * dc) + div255(dc * (255 - a)),
                _ => {
                    let t = if dc <= 127 { 2 * div255(sc * dc) } else { a - (2 * div255((255 - dc) * (a - sc))).min(a) };
                    div255(dc * (255 - a)) + t
                }
            };
            d[ch] = v.min(255) as u8;
        }
    }
}

/// Multiplies premultiplied pixels by mask values (0..255).
fn apply_mask(px: &mut [u32], m: &[u8]) {
    for (p, &k) in px.iter_mut().zip(m) {
        if k == 255 { continue; }
        let k = k as u32 + (k >> 7) as u32; // 0..256
        let rb = (((*p & 0x00ff_00ff) * k) >> 8) & 0x00ff_00ff;
        let ag = (((*p >> 8) & 0x00ff_00ff) * k) & 0xff00_ff00;
        *p = rb | ag;
    }
}

/// Fills `out` (rect r, row-major) with mask values from the mask spec in args[14..23]: a
/// sprite's alpha or luma, placed by its own transform, optionally inverted. Rows outside the
/// mask sprite are 0 (255 inverted).
fn build_mask(s: &State, a: &[f32], r: Rect, out: &mut Vec<u8>, row: &mut Vec<u32>) {
    let (w, h) = ((r.x1 - r.x0) as usize, (r.y1 - r.y0) as usize);
    out.clear();
    out.resize(w * h, 0);
    let sp = &s.sprites[a[14] as usize];
    let placed = Placed { pix: as_u32(sp.pix.data()), x: sp.x, y: sp.y, w: sp.pix.width() as usize, h: sp.pix.height() as usize, tf: Affine::at(&a[17..23]) };
    let luma = a[15] as u32 == 1;
    let invert = a[16] != 0.0;
    row.resize(w, 0);
    for y in 0..h {
        placed.row(r.y0 + y as i32, r.x0, &mut row[..w]);
        let o = &mut out[y * w..(y + 1) * w];
        for (m, &p) in o.iter_mut().zip(row.iter()) {
            let v = if luma {
                // Premultiplied, so this is luma x alpha.
                ((p & 255) * 54 + ((p >> 8) & 255) * 183 + ((p >> 16) & 255) * 19) >> 8
            } else {
                p >> 24
            };
            *m = if invert { 255 - v as u8 } else { v as u8 };
        }
    }
}

// ------------------------------------------------------------------ sprites

/// Composites a sprite over the frame. Arguments in ARGS (see there): opacity, blur sigma (frame
/// px, applied before the transform), blend mode, clip rectangle, an affine transform sampled
/// bilinearly (an integer translation copies pixels), and an optional mask.
#[no_mangle]
pub extern "C" fn draw_ex() {
    let a = args();
    let opacity = a[1];
    if !(opacity > 0.0) { return; }
    let s = st();
    let id = a[0] as usize;
    let (w, h) = (s.sprites[id].pix.width() as usize, s.sprites[id].pix.height() as usize);
    let (sx, sy) = (s.sprites[id].x, s.sprites[id].y);
    let blurred = a[2] > 0.05;
    if blurred {
        s.scratch.clear();
        s.scratch.extend_from_slice(s.sprites[id].pix.data());
        blur(&mut s.scratch, w, h, a[2], &mut s.blur);
    }
    let src: &[u8] = if blurred { &s.scratch } else { s.sprites[id].pix.data() };
    let placed = Placed { pix: as_u32(src), x: sx, y: sy, w, h, tf: Affine::at(&a[8..14]) };
    let r = placed.bounds().and(Rect::clip(&a)).and(Rect::frame(s));
    if r.empty() { return; }
    let masked = a[14] >= 0.0;
    let mut mask = std::mem::take(&mut s.mask_buf);
    let mut row = std::mem::take(&mut s.row_buf);
    if masked { build_mask(s, &a, r, &mut mask, &mut row); }
    let rw = (r.x1 - r.x0) as usize;
    row.resize(rw, 0);
    let op = (opacity.clamp(0.0, 1.0) * 256.0) as u16;
    let mode = a[3] as u32;
    let W = s.w;
    let out = s.frame.data_mut();
    let direct = if masked { None } else { placed.tf.offset() };
    for y in r.y0..r.y1 {
        let o = (y as usize * W + r.x0 as usize) * 4;
        let d = &mut out[o..o + rw * 4];
        if let Some((dx, dy)) = direct {
            // Untransformed and unmasked: blend straight from the sprite's rows.
            let i = ((y - sy - dy) as usize * w + (r.x0 - sx - dx) as usize) * 4;
            let srow = &src[i..i + rw * 4];
            if mode == NORMAL { blend_row(d, srow, op) } else { blend_mode_row(d, srow, op, mode) }
            continue;
        }
        let (sa, sb) = placed.span(y, r.x0, r.x1);
        if sb <= sa { continue; }
        let (ka, kb) = ((sa - r.x0) as usize, (sb - r.x0) as usize);
        placed.row(y, sa, &mut row[ka..kb]);
        if masked { apply_mask(&mut row[ka..kb], &mask[(y - r.y0) as usize * rw + ka..(y - r.y0) as usize * rw + kb]); }
        let srow = unsafe { std::slice::from_raw_parts(row.as_ptr().add(ka) as *const u8, (kb - ka) * 4) };
        let d = &mut d[ka * 4..kb * 4];
        if mode == NORMAL { blend_row(d, srow, op) } else { blend_mode_row(d, srow, op, mode) }
    }
    s.mask_buf = mask;
    s.row_buf = row;
    mark_rect(s, r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32);
}

/// The paint described at args[1..4] and args[24..]: a solid colour or a gradient, in path units.
fn paint_ex(a: &[f32], alpha: f32, rgb: u32, blend: u32) -> Paint<'static> {
    let mut p = paint(rgb, alpha);
    p.blend_mode = skia_blend(blend);
    let kind = a[24] as u32;
    if kind == 0 { return p; }
    let n = (a[29] as usize).min(MAX_STOPS);
    let stops: Vec<GradientStop> = (0..n)
        .map(|i| {
            let o = 30 + i * 5;
            let c = Color::from_rgba(a[o + 1], a[o + 2], a[o + 3], (a[o + 4] * alpha).clamp(0.0, 1.0)).unwrap_or(Color::BLACK);
            GradientStop::new(a[o], c)
        })
        .collect();
    let shader = if kind == 1 {
        LinearGradient::new(Point::from_xy(a[25], a[26]), Point::from_xy(a[27], a[28]), stops, SpreadMode::Pad, Transform::identity())
    } else {
        RadialGradient::new(Point::from_xy(a[25], a[26]), Point::from_xy(a[25], a[26]), a[27], stops, SpreadMode::Pad, Transform::identity())
    };
    if let Some(sh) = shader { p.shader = sh; }
    p
}

/// Fills a path into a sprite with the paint in ARGS (solid or gradient, blend mode). The
/// transform (args[8..14]) maps path units to frame pixels.
#[no_mangle]
pub extern "C" fn sprite_fill_ex(id: i32) {
    let a = args();
    let s = st();
    let p = &s.paths[a[0] as usize];
    let sp = &mut s.sprites[id as usize];
    let t = Affine::at(&a[8..14]).0;
    let t = tf(t[0], t[1], t[2], t[3], t[4], t[5]).post_translate(-sp.x as f32, -sp.y as f32);
    let rule = if a[23] != 0.0 { FillRule::EvenOdd } else { FillRule::Winding };
    sp.pix.fill_path(p, &paint_ex(&a, a[1], a[3] as u32, a[2] as u32), rule, t, None);
}

/// Live vector fill straight into the frame, with the paint, blend mode, clip rectangle and mask
/// in ARGS.
#[no_mangle]
pub extern "C" fn fill_ex() {
    let a = args();
    let alpha = a[1];
    if !(alpha > 0.0) { return; }
    let s = st();
    let t = Affine::at(&a[8..14]);
    let bb = s.paths[a[0] as usize].bounds();
    let r = Rect::outer(t.bounds(bb.left(), bb.top(), bb.right(), bb.bottom()));
    // One pixel of antialiasing on each side.
    let r = Rect { x0: r.x0 - 1, y0: r.y0 - 1, x1: r.x1 + 1, y1: r.y1 + 1 }.and(Rect::frame(s));
    let clip = Rect::clip(&a);
    let rc = r.and(clip);
    if rc.empty() { return; }
    let masked = a[14] >= 0.0;
    let clipped = rc.x0 > r.x0 || rc.y0 > r.y0 || rc.x1 < r.x1 || rc.y1 < r.y1;
    let rule = if a[23] != 0.0 { FillRule::EvenOdd } else { FillRule::Winding };
    let m = t.0;
    let t = tf(m[0], m[1], m[2], m[3], m[4], m[5]);
    let p = paint_ex(&a, alpha, a[3] as u32, a[2] as u32);
    if masked || clipped {
        // A frame-size mask, written only inside the fill's bounds (tiny-skia reads nothing else).
        let (W, H) = (s.w, s.h);
        let mut fm = s.fill_mask.take().unwrap_or_else(|| Mask::new(W as u32, H as u32).unwrap());
        let mut tmp = std::mem::take(&mut s.mask_buf);
        let mut row = std::mem::take(&mut s.row_buf);
        if masked { build_mask(s, &a, r, &mut tmp, &mut row); }
        let rw = (r.x1 - r.x0) as usize;
        let md = fm.data_mut();
        for y in r.y0..r.y1 {
            let o = y as usize * W + r.x0 as usize;
            for x in 0..rw {
                let inside = y >= rc.y0 && y < rc.y1 && (r.x0 + x as i32) >= rc.x0 && (r.x0 + x as i32) < rc.x1;
                md[o + x] = if !inside { 0 } else if masked { tmp[(y - r.y0) as usize * rw + x] } else { 255 };
            }
        }
        s.frame.fill_path(&s.paths[a[0] as usize], &p, rule, t, Some(&fm));
        s.fill_mask = Some(fm);
        s.mask_buf = tmp;
        s.row_buf = row;
    } else {
        s.frame.fill_path(&s.paths[a[0] as usize], &p, rule, t, None);
    }
    mark_rect(s, rc.x0 as f32, rc.y0 as f32, rc.x1 as f32, rc.y1 as f32);
}

/// Multiplies a sprite by a path's coverage (frame coordinates): rounded image corners, shaped
/// cut-outs. `invert` keeps what is outside the path instead.
#[no_mangle]
pub extern "C" fn sprite_clip(id: i32, path: i32, evenodd: i32, invert: i32) {
    let s = st();
    let p = &s.paths[path as usize];
    let sp = &mut s.sprites[id as usize];
    let (w, h) = (sp.pix.width(), sp.pix.height());
    let mut m = Mask::new(w, h).unwrap();
    let rule = if evenodd != 0 { FillRule::EvenOdd } else { FillRule::Winding };
    m.fill_path(p, rule, true, Transform::from_translate(-sp.x as f32, -sp.y as f32));
    let md: Vec<u8> = if invert != 0 { m.data().iter().map(|v| 255 - v).collect() } else { m.data().to_vec() };
    let px = rows_u32(sp.pix.data_mut());
    apply_mask(px, &md);
}

/// A new sprite holding the drop shadow (or glow) of `src`: its alpha, blurred by `sigma`, in
/// colour `rgb` at `alpha`, grown by `spread` px first. Same frame position as `src`; draw it
/// with an offset transform.
#[no_mangle]
pub extern "C" fn sprite_shadow(src: i32, sigma: f32, rgb: u32, alpha: f32, spread: f32) -> i32 {
    let s = st();
    let pad = (sigma * 3.0).ceil() as usize + spread.max(0.0).ceil() as usize + 2;
    let sp = &s.sprites[src as usize];
    let (w, h) = (sp.pix.width() as usize, sp.pix.height() as usize);
    let (nw, nh) = (w + 2 * pad, h + 2 * pad);
    let mut a = vec![0u8; nw * nh * 4];
    let srcpx = sp.pix.data();
    for y in 0..h {
        for x in 0..w {
            let v = srcpx[(y * w + x) * 4 + 3];
            let o = ((y + pad) * nw + x + pad) * 4;
            a[o..o + 4].fill(v);
        }
    }
    let sp_r = spread.max(0.0).round() as usize;
    if sp_r > 0 {
        // Dilate: max over a (2r + 1)^2 square, as two 1-D passes.
        let mut t = a.clone();
        for y in 0..nh {
            for x in 0..nw {
                let mut m = 0;
                for k in x.saturating_sub(sp_r)..(x + sp_r + 1).min(nw) { m = m.max(a[(y * nw + k) * 4]); }
                t[(y * nw + x) * 4..(y * nw + x) * 4 + 4].fill(m);
            }
        }
        for y in 0..nh {
            for x in 0..nw {
                let mut m = 0;
                for k in y.saturating_sub(sp_r)..(y + sp_r + 1).min(nh) { m = m.max(t[(k * nw + x) * 4]); }
                a[(y * nw + x) * 4..(y * nw + x) * 4 + 4].fill(m);
            }
        }
    }
    let (sx, sy) = (sp.x - pad as i32, sp.y - pad as i32);
    blur(&mut a, nw, nh, sigma, &mut s.blur);
    let k = (alpha.clamp(0.0, 1.0) * 256.0) as u32;
    let c = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
    for p in a.chunks_exact_mut(4) {
        let v = (p[3] as u32 * k) >> 8;
        for ch in 0..3 { p[ch] = div255(c[ch] * v) as u8; }
        p[3] = v as u8;
    }
    let mut pix = Pixmap::new(nw as u32, nh as u32).unwrap();
    pix.data_mut().copy_from_slice(&a);
    s.sprites.push(Sprite { x: sx, y: sy, pix });
    (s.sprites.len() - 1) as i32
}

// ------------------------------------------------------------------ dot matrix

/// A field of dots (a halftone of some source), each with a value, colour and reveal threshold.
struct Dots {
    /// x, y (top-left, frame px), value 0..1, threshold, rgb.
    dots: Vec<(i32, i32, f32, f32, u32)>,
    /// Coverage stamps (tile x tile) for nine sizes, from nothing (0) to the full dot (8).
    stamps: Vec<Vec<u8>>,
    tile: usize,
}

/// Registers a dot field: `n` dots of 5 floats each (x, y, value, threshold, rgb) at `ptr`,
/// drawn as `size` px squares (or circles when `round`).
#[no_mangle]
pub unsafe extern "C" fn dots_new(ptr: *const f32, n: usize, size: f32, round: i32) -> i32 {
    let d = std::slice::from_raw_parts(ptr, n * 5);
    let tile = size.ceil().max(1.0) as usize;
    let mut stamps = vec![vec![0u8; tile * tile]];
    for k in 1..=8 {
        let r = size * k as f32 / 8.0;
        let c = tile as f32 / 2.0;
        let mut pb = PathBuilder::new();
        if round != 0 {
            pb.push_circle(c, c, r / 2.0);
        } else {
            pb.push_rect(tiny_skia::Rect::from_xywh(c - r / 2.0, c - r / 2.0, r, r).unwrap());
        }
        let mut m = Mask::new(tile as u32, tile as u32).unwrap();
        if let Some(p) = pb.finish() { m.fill_path(&p, FillRule::Winding, true, Transform::identity()); }
        stamps.push(m.data().to_vec());
    }
    let dots = d.chunks_exact(5).map(|c| (c[0] as i32, c[1] as i32, c[2], c[3], c[4] as u32)).collect();
    let s = st();
    s.dots.push(Dots { dots, stamps, tile });
    (s.dots.len() - 1) as i32
}

/// Draws a dot field at reveal `progress`: a dot shows once progress passes its threshold,
/// fading (or growing, with `grow`) in over `softness`. `rgb` < 0 uses each dot's own colour;
/// `reverse` reveals in the opposite order (thresholds 1 - t).
#[no_mangle]
pub extern "C" fn dots_draw(id: i32, progress: f32, softness: f32, opacity: f32, grow: i32, rgb: i32, reverse: i32) {
    if !(opacity > 0.0) { return; }
    let s = st();
    let (W, H) = (s.w as i32, s.h as i32);
    let f = &s.dots[id as usize];
    let tile = f.tile as i32;
    let out = rows_u32(s.frame.data_mut());
    let mut b = Rect { x0: i32::MAX, y0: i32::MAX, x1: i32::MIN, y1: i32::MIN };
    for &(x, y, v, t, c) in &f.dots {
        let t = if reverse != 0 { 1.0 - t } else { t };
        let k = if softness > 0.0 { ((progress - t) / softness).clamp(0.0, 1.0) } else if progress >= t { 1.0 } else { 0.0 };
        if k <= 0.0 { continue; }
        let (level, a) = if grow != 0 { ((k * 8.0).ceil() as usize, v * opacity) } else { (8, v * opacity * k) };
        let a = (a.clamp(0.0, 1.0) * 256.0) as u32;
        if a == 0 || level == 0 { continue; }
        let c = if rgb >= 0 { rgb as u32 } else { c };
        let (cr, cg, cb) = ((c >> 16) & 255, (c >> 8) & 255, c & 255);
        let stamp = &f.stamps[level.min(8)];
        for ty in 0..tile {
            let fy = y + ty;
            if fy < 0 || fy >= H { continue; }
            for tx in 0..tile {
                let fx = x + tx;
                if fx < 0 || fx >= W { continue; }
                let cov = stamp[(ty * tile + tx) as usize] as u32;
                if cov == 0 { continue; }
                let al = (cov * a) >> 8; // 0..255
                let p = &mut out[(fy * W + fx) as usize];
                let (dr, dg, db) = (*p & 255, (*p >> 8) & 255, (*p >> 16) & 255);
                let mixc = |d: u32, s: u32| div255(d * (255 - al) + s * al);
                *p = 0xff00_0000 | mixc(dr, cr) | (mixc(dg, cg) << 8) | (mixc(db, cb) << 16);
            }
        }
        b = Rect { x0: b.x0.min(x), y0: b.y0.min(y), x1: b.x1.max(x + tile), y1: b.y1.max(y + tile) };
    }
    if !b.empty() { mark_rect(s, b.x0 as f32, b.y0 as f32, b.x1 as f32, b.y1 as f32); }
}

// ------------------------------------------------------------------ images

/// Largest decoded image, in pixels. JPEGs are decoded at a reduced DCT scale first when they
/// are bigger than needed, so this mostly limits PNG and WebP.
const MAX_IMAGE_PIXELS: usize = 4 << 20;
/// Largest side accepted in an image header, before any scaling.
const MAX_IMAGE_SIDE: usize = 16384;

struct Image {
    w: usize,
    h: usize,
    /// Straight (not premultiplied) RGBA.
    px: Vec<u8>,
}

fn decode_image(bytes: &[u8], want_w: u16, want_h: u16) -> Result<Image, i32> {
    use std::io::Cursor;
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut d = jpeg_decoder::Decoder::new(Cursor::new(bytes));
        d.set_max_decoding_buffer_size(MAX_IMAGE_PIXELS * 4);
        d.read_info().map_err(|_| -3)?;
        let info = d.info().ok_or(-3)?;
        if info.width as usize > MAX_IMAGE_SIDE || info.height as usize > MAX_IMAGE_SIDE { return Err(-2); }
        let (w, h) = d.scale(want_w.max(1), want_h.max(1)).map_err(|_| -3)?;
        let (w, h) = (w as usize, h as usize);
        if w * h > MAX_IMAGE_PIXELS { return Err(-2); }
        let data = d.decode().map_err(|_| -3)?;
        let info = d.info().ok_or(-3)?;
        let mut px = vec![255u8; w * h * 4];
        use jpeg_decoder::PixelFormat as F;
        match info.pixel_format {
            F::L8 => for i in 0..w * h { px[i * 4..i * 4 + 3].fill(data[i]) },
            F::L16 => for i in 0..w * h { px[i * 4..i * 4 + 3].fill(data[i * 2]) },
            F::RGB24 => for i in 0..w * h { px[i * 4..i * 4 + 3].copy_from_slice(&data[i * 3..i * 3 + 3]) },
            F::CMYK32 => for i in 0..w * h {
                let k = data[i * 4 + 3] as u32;
                for ch in 0..3 { px[i * 4 + ch] = div255(data[i * 4 + ch] as u32 * k) as u8; }
            },
        }
        return Ok(Image { w, h, px });
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let mut d = png::Decoder::new_with_limits(Cursor::new(bytes), png::Limits { bytes: MAX_IMAGE_PIXELS * 8 });
        d.set_transformations(png::Transformations::normalize_to_color8());
        let mut r = d.read_info().map_err(|_| -3)?;
        let (w, h) = (r.info().width as usize, r.info().height as usize);
        if w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE || w * h > MAX_IMAGE_PIXELS { return Err(-2); }
        let mut buf = vec![0u8; r.output_buffer_size().ok_or(-2)?];
        let fi = r.next_frame(&mut buf).map_err(|_| -3)?;
        let mut px = vec![255u8; w * h * 4];
        use png::ColorType as C;
        let stride = fi.line_size;
        for y in 0..h {
            let row = &buf[y * stride..];
            for x in 0..w {
                let o = (y * w + x) * 4;
                match fi.color_type {
                    C::Grayscale => px[o..o + 3].fill(row[x]),
                    C::GrayscaleAlpha => { px[o..o + 3].fill(row[x * 2]); px[o + 3] = row[x * 2 + 1] }
                    C::Rgb => px[o..o + 3].copy_from_slice(&row[x * 3..x * 3 + 3]),
                    _ => px[o..o + 4].copy_from_slice(&row[x * 4..x * 4 + 4]),
                }
            }
        }
        return Ok(Image { w, h, px });
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let mut d = image_webp::WebPDecoder::new(Cursor::new(bytes)).map_err(|_| -3)?;
        let (w, h) = d.dimensions();
        let (w, h) = (w as usize, h as usize);
        if w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE || w * h > MAX_IMAGE_PIXELS { return Err(-2); }
        let alpha = d.has_alpha();
        let mut buf = vec![0u8; d.output_buffer_size().ok_or(-2)?];
        d.read_image(&mut buf).map_err(|_| -3)?;
        let px = if alpha { buf } else {
            let mut px = vec![255u8; w * h * 4];
            for i in 0..w * h { px[i * 4..i * 4 + 3].copy_from_slice(&buf[i * 3..i * 3 + 3]) }
            px
        };
        return Ok(Image { w, h, px });
    }
    Err(-1)
}

/// Decodes a PNG, JPEG or WebP held at `ptr`. `want_w` x `want_h` is the size it will be drawn
/// at, which lets JPEGs decode at a reduced scale. Returns 0, or -1 (unsupported format),
/// -2 (too large) or -3 (corrupt). The image is kept until the next decode or `image_free`.
#[no_mangle]
pub unsafe extern "C" fn image_decode(ptr: *const u8, len: usize, want_w: u32, want_h: u32) -> i32 {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let s = st();
    s.image = None;
    match decode_image(bytes, want_w.min(65535) as u16, want_h.min(65535) as u16) {
        Ok(img) => { s.image = Some(img); 0 }
        Err(e) => e,
    }
}

#[no_mangle]
pub extern "C" fn image_width() -> u32 { st().image.as_ref().map_or(0, |i| i.w as u32) }

#[no_mangle]
pub extern "C" fn image_height() -> u32 { st().image.as_ref().map_or(0, |i| i.h as u32) }

#[no_mangle]
pub extern "C" fn image_free() { st().image = None; }

/// Per output pixel along one axis: the first source index and its weights. Shrinking averages
/// the source span each output pixel covers (area filter); enlarging interpolates linearly.
fn resample_taps(start: f32, len: f32, n_src: usize, n_out: usize) -> Vec<(usize, Vec<f32>)> {
    let k = len / n_out as f32;
    (0..n_out)
        .map(|o| {
            if k >= 1.0 {
                let (a, b) = (start + o as f32 * k, start + (o + 1) as f32 * k);
                let i0 = (a.floor().max(0.0) as usize).min(n_src - 1);
                let i1 = (b.ceil().max(1.0) as usize).min(n_src);
                let ws: Vec<f32> = (i0..i1.max(i0 + 1)).map(|i| ((i + 1) as f32).min(b) - (i as f32).max(a)).map(|w| w.max(0.0) / k).collect();
                (i0, ws)
            } else {
                let c = (start + (o as f32 + 0.5) * k - 0.5).clamp(0.0, (n_src - 1) as f32);
                let i0 = (c.floor() as usize).min(n_src - 1);
                let f = c - i0 as f32;
                if i0 + 1 < n_src { (i0, vec![1.0 - f, f]) } else { (i0, vec![1.0]) }
            }
        })
        .collect()
}

/// Resamples the crop [cx, cx + cw) x [cy, cy + ch) of the decoded image (source px) into the
/// whole of sprite `id`, premultiplied.
#[no_mangle]
pub extern "C" fn image_to_sprite(id: i32, cx: f32, cy: f32, cw: f32, ch: f32) -> i32 {
    let s = st();
    let Some(img) = s.image.as_ref() else { return -1 };
    let sp = &mut s.sprites[id as usize];
    let (ow, oh) = (sp.pix.width() as usize, sp.pix.height() as usize);
    let cols = resample_taps(cx, cw, img.w, ow);
    let rows = resample_taps(cy, ch, img.h, oh);
    // Premultiplied float rows, horizontal pass first, only for the source rows in use.
    let (r0, r1) = (rows.first().map_or(0, |r| r.0), rows.last().map_or(0, |r| r.0 + r.1.len()).min(img.h));
    let mut hp = vec![0f32; (r1 - r0) * ow * 4];
    for y in r0..r1 {
        let src = &img.px[y * img.w * 4..(y + 1) * img.w * 4];
        let out = &mut hp[(y - r0) * ow * 4..(y - r0 + 1) * ow * 4];
        for (x, (i0, ws)) in cols.iter().enumerate() {
            let mut acc = [0f32; 4];
            for (j, &wt) in ws.iter().enumerate() {
                let p = &src[(i0 + j) * 4..(i0 + j) * 4 + 4];
                let a = p[3] as f32 / 255.0 * wt;
                acc[0] += p[0] as f32 * a;
                acc[1] += p[1] as f32 * a;
                acc[2] += p[2] as f32 * a;
                acc[3] += p[3] as f32 * wt;
            }
            out[x * 4..x * 4 + 4].copy_from_slice(&acc);
        }
    }
    let out = sp.pix.data_mut();
    for (y, (i0, ws)) in rows.iter().enumerate() {
        for x in 0..ow {
            let mut acc = [0f32; 4];
            for (j, &wt) in ws.iter().enumerate() {
                let r = i0 + j - r0;
                for ch in 0..4 { acc[ch] += hp[(r * ow + x) * 4 + ch] * wt; }
            }
            let a = acc[3].clamp(0.0, 255.0);
            let o = (y * ow + x) * 4;
            for ch in 0..3 { out[o + ch] = (acc[ch] + 0.5).clamp(0.0, a + 0.5) as u8; }
            out[o + 3] = (a + 0.5) as u8;
        }
    }
    0
}

/// A sprite's premultiplied RGBA pixels, for content drawn in JS (gradients).
#[no_mangle]
pub extern "C" fn sprite_ptr(id: i32) -> *mut u8 {
    st().sprites[id as usize].pix.data_mut().as_mut_ptr()
}

// ------------------------------------------------------------------ output

#[no_mangle]
pub extern "C" fn frame_ptr() -> *const u8 {
    st().frame.data().as_ptr()
}

/// Slice equality in 16-byte steps (`==` on u8 slices lowers to a byte-wise memcmp in wasm).
#[inline]
fn eq(a: &[u8], b: &[u8]) -> bool {
    let mut ca = a.chunks_exact(16);
    let mut cb = b.chunks_exact(16);
    for (x, y) in (&mut ca).zip(&mut cb) {
        if u128::from_ne_bytes(x.try_into().unwrap()) != u128::from_ne_bytes(y.try_into().unwrap()) { return false; }
    }
    ca.remainder() == cb.remainder()
}


/// Converts one 16x16 macroblock (clipped to the frame height) to BT.709 limited-range I420,
/// sixteen pixels per step in wasm SIMD. Same fixed-point maths as the scalar reference.
/// Output is a packed block: Y rows at 16 * r, U rows at 256 + 8 * r, V rows at 320 + 8 * r;
/// rows past the frame's bottom edge are left untouched.
fn convert_mb(px: &[u8], out: &mut [u8; 384], mx: usize, my: usize, W: usize, H: usize) {
    let (yp, uv) = out.split_at_mut(256);
    let (up, vp) = uv.split_at_mut(64);
    let x0 = mx * 16;
    let y0 = my * 16;
    let y1 = (y0 + 16).min(H);
    unsafe {
        let (yr, yg, yb) = (u16x8_splat(11966), u16x8_splat(40254), u16x8_splat(4064));
        let rnd = u32x4_splat(32768);
        let k16 = i16x8_splat(16);
        // R and G of 8 pixels (low/high halves) and B of 8 pixels from two 4-pixel vectors.
        let split = |a: v128, b: v128| -> (v128, v128, v128) {
            let rg = i8x16_shuffle::<0, 4, 8, 12, 16, 20, 24, 28, 1, 5, 9, 13, 17, 21, 25, 29>(a, b);
            let bb = i8x16_shuffle::<2, 6, 10, 14, 18, 22, 26, 30, 2, 6, 10, 14, 18, 22, 26, 30>(a, b);
            (u16x8_extend_low_u8x16(rg), u16x8_extend_high_u8x16(rg), u16x8_extend_low_u8x16(bb))
        };
        let luma8 = |r: v128, g: v128, b: v128| -> v128 {
            let lo = u32x4_shr(i32x4_add(i32x4_add(u32x4_extmul_low_u16x8(r, yr), u32x4_extmul_low_u16x8(g, yg)), i32x4_add(u32x4_extmul_low_u16x8(b, yb), rnd)), 16);
            let hi = u32x4_shr(i32x4_add(i32x4_add(u32x4_extmul_high_u16x8(r, yr), u32x4_extmul_high_u16x8(g, yg)), i32x4_add(u32x4_extmul_high_u16x8(b, yb), rnd)), 16);
            i16x8_add(i16x8_narrow_i32x4(lo, hi), k16)
        };
        let row = |y: usize| -> [(v128, v128, v128); 2] {
            let p = px.as_ptr().add((y * W + x0) * 4) as *const v128;
            [split(v128_load(p), v128_load(p.add(1))), split(v128_load(p.add(2)), v128_load(p.add(3)))]
        };
        for y in y0..y1 {
            let [(r0, g0, b0), (r1, g1, b1)] = row(y);
            let out = u8x16_narrow_i16x8(luma8(r0, g0, b0), luma8(r1, g1, b1));
            v128_store(yp.as_mut_ptr().add((y - y0) * 16) as *mut v128, out);
        }
        let (ur, ug, ub) = (i32x4_splat(-6597), i32x4_splat(-22187), i32x4_splat(28784));
        let (vr, vg, vb) = (i32x4_splat(28784), i32x4_splat(-26147), i32x4_splat(-2637));
        let crnd = i32x4_splat(1 << 17);
        let k128 = i16x8_splat(128);
        let chroma = |r: v128, g: v128, b: v128, cr: v128, cg: v128, cb: v128| -> v128 {
            i32x4_shr(i32x4_add(i32x4_add(i32x4_mul(r, cr), i32x4_mul(g, cg)), i32x4_add(i32x4_mul(b, cb), crnd)), 18)
        };
        for cy in y0 / 2..y1 / 2 {
            let a = row(2 * cy);
            let b = row(2 * cy + 1);
            // 2x2 sums: add the two rows, then adjacent pixels.
            let sum = |h: usize, c: usize| -> v128 {
                let pick = |t: &(v128, v128, v128)| match c { 0 => t.0, 1 => t.1, _ => t.2 };
                i32x4_extadd_pairwise_u16x8(i16x8_add(pick(&a[h]), pick(&b[h])))
            };
            let (ra, ga, ba) = (sum(0, 0), sum(0, 1), sum(0, 2));
            let (rb, gb, bb) = (sum(1, 0), sum(1, 1), sum(1, 2));
            let u = i16x8_add(i16x8_narrow_i32x4(chroma(ra, ga, ba, ur, ug, ub), chroma(rb, gb, bb, ur, ug, ub)), k128);
            let v = i16x8_add(i16x8_narrow_i32x4(chroma(ra, ga, ba, vr, vg, vb), chroma(rb, gb, bb, vr, vg, vb)), k128);
            let o = (cy - y0 / 2) * 8;
            v128_store64_lane::<0>(u8x16_narrow_i16x8(u, u), up.as_mut_ptr().add(o) as *mut u64);
            v128_store64_lane::<0>(u8x16_narrow_i16x8(v, v), vp.as_mut_ptr().add(o) as *mut u64);
        }
    }
}

/// Copies a converted block into the I420 planes, or (store = false) reports whether it differs.
fn mb_io(yuv: &mut [u8], blk: &[u8; 384], mx: usize, my: usize, store: bool, W: usize, H: usize) -> bool {
    let (yp, uv) = yuv.split_at_mut(W * H);
    let (up, vp) = uv.split_at_mut(W * H / 4);
    let (x0, y0) = (mx * 16, my * 16);
    let rows = (H - y0).min(16);
    let mut differs = false;
    for r in 0..rows {
        let d = &mut yp[(y0 + r) * W + x0..(y0 + r) * W + x0 + 16];
        let b = &blk[r * 16..r * 16 + 16];
        if store { d.copy_from_slice(b) } else if !eq(d, b) { differs = true }
    }
    for r in 0..rows / 2 {
        let o = (y0 / 2 + r) * W / 2 + x0 / 2;
        for (plane, off) in [(&mut *up, 256), (&mut *vp, 320)] {
            let d = &mut plane[o..o + 8];
            let b = &blk[off + r * 8..off + r * 8 + 8];
            if store { d.copy_from_slice(b) } else if d != b { differs = true }
        }
    }
    differs
}

/// BT.709 limited-range I420 (Y then U then V, tightly packed), chroma from the 2x2 average.
/// Each candidate macroblock is converted and compared with what the planes already hold (the
/// previous frame), so `mb_info()` marks X264_MBINFO_CONSTANT (1) for every block whose YUV did
/// not change and x264 skips analysing it. Blocks no overlay touched on an unchanged base are
/// constant without converting them. Returns the number of changed macroblocks.
#[no_mangle]
pub extern "C" fn to_i420() -> u32 {
    let s = st();
    let (W, H, MBW, MBH) = (s.w, s.h, s.mbw, s.mbh);
    let px = s.frame.data();
    let mut changed = 0;
    let check_all = s.full || !s.prev_valid;
    for my in 0..MBH {
        for mx in 0..MBW {
            let m = my * MBW + mx;
            if !check_all && s.touched[0][m] == 0 && s.touched[1][m] == 0 {
                s.mb_info[m] = 1;
                continue;
            }
            convert_mb(px, &mut s.mb_tmp, mx, my, W, H);
            let differs = !s.prev_valid || mb_io(&mut s.yuv, &s.mb_tmp, mx, my, false, W, H);
            s.mb_info[m] = (!differs) as u8;
            if differs {
                changed += 1;
                mb_io(&mut s.yuv, &s.mb_tmp, mx, my, true, W, H);
            }
        }
    }
    s.prev_valid = true;
    changed
}

#[no_mangle]
pub extern "C" fn yuv_ptr() -> *const u8 {
    st().yuv.as_ptr()
}

#[no_mangle]
pub extern "C" fn mb_info_ptr() -> *const u8 {
    st().mb_info.as_ptr()
}

/// A sprite's frame position and size, for JS that reads its pixels (dot fields, caches).
#[no_mangle]
pub extern "C" fn sprite_x(id: i32) -> i32 { st().sprites[id as usize].x }
#[no_mangle]
pub extern "C" fn sprite_y(id: i32) -> i32 { st().sprites[id as usize].y }
#[no_mangle]
pub extern "C" fn sprite_w(id: i32) -> u32 { st().sprites[id as usize].pix.width() }
#[no_mangle]
pub extern "C" fn sprite_h(id: i32) -> u32 { st().sprites[id as usize].pix.height() }
