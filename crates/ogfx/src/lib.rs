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
    Color, FillRule, Mask, Paint, Path, PathBuilder, Pixmap, Transform,
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
    scratch: Vec<u8>,
    scratch2: Vec<u8>,
    prefix: Vec<u32>,
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
            scratch2: Vec::new(),
            prefix: Vec::new(),
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

// ------------------------------------------------------------------ sprites

/// Three box blurs approximating a Gaussian (SVG feGaussianBlur's rule), on premultiplied RGBA.
fn box_blur(src: &mut [u8], tmp: &mut Vec<u8>, pre: &mut Vec<u32>, w: usize, h: usize, sigma: f32) {
    let d = (sigma * 3.0 * (2.0 * std::f32::consts::PI).sqrt() / 4.0 + 0.5).floor() as usize;
    if d < 1 { return; }
    tmp.resize(src.len(), 0);
    // (size, offset) per pass; an even size alternates its centre, the third pass grows by one.
    let passes: [(usize, usize); 3] = if d % 2 == 1 {
        [(d, d / 2), (d, d / 2), (d, d / 2)]
    } else {
        [(d, d / 2), (d, d / 2 - 1), (d + 1, d / 2)]
    };
    for &(size, off) in &passes { box_h(src, tmp, pre, w, h, size, off); }
    for &(size, off) in &passes { box_v(src, tmp, pre, w, h, size, off); }
}

/// One horizontal box pass; samples outside the sprite are transparent.
fn box_h(src: &mut [u8], tmp: &mut [u8], pre: &mut Vec<u32>, w: usize, h: usize, size: usize, off: usize) {
    let div = size as u32;
    pre.resize((w + 1) * 4, 0);
    for y in 0..h {
        let row = &src[y * w * 4..(y + 1) * w * 4];
        let orow = &mut tmp[y * w * 4..(y + 1) * w * 4];
        // Interleaved prefix sums: pre[4 * x + ch] = sum of channel ch over pixels [0, x).
        pre[..4].fill(0);
        for x in 0..w {
            for ch in 0..4 { pre[4 * (x + 1) + ch] = pre[4 * x + ch] + row[4 * x + ch] as u32; }
        }
        for x in 0..w {
            let lo = (x as isize - off as isize).clamp(0, w as isize) as usize;
            let hi = (x as isize - off as isize + size as isize).clamp(0, w as isize) as usize;
            for ch in 0..4 {
                orow[4 * x + ch] = ((pre[4 * hi + ch] - pre[4 * lo + ch] + div / 2) / div) as u8;
            }
        }
    }
    src.copy_from_slice(tmp);
}

/// One vertical box pass, as a running window down each column (all columns at once per row).
fn box_v(src: &mut [u8], tmp: &mut [u8], acc: &mut Vec<u32>, w: usize, h: usize, size: usize, off: usize) {
    let div = size as u32;
    let n = w * 4;
    acc.clear();
    acc.resize(n, 0);
    // Window for output row y is source rows [y - off, y - off + size).
    let add = |acc: &mut [u32], src: &[u8], r: isize, sign: bool| {
        if r < 0 || r >= h as isize { return; }
        let row = &src[r as usize * n..(r as usize + 1) * n];
        if sign { for i in 0..n { acc[i] += row[i] as u32; } } else { for i in 0..n { acc[i] -= row[i] as u32; } }
    };
    for r in -(off as isize)..(size as isize - off as isize - 1) { add(acc, src, r, true); }
    for y in 0..h {
        add(acc, src, y as isize - off as isize + size as isize - 1, true);
        let o = &mut tmp[y * n..(y + 1) * n];
        for i in 0..n { o[i] = ((acc[i] + div / 2) / div) as u8; }
        add(acc, src, y as isize - off as isize, false);
    }
    src.copy_from_slice(tmp);
}

/// Composites a sprite over the frame with `opacity`, blurred by `sigma` (frame px) first.
#[no_mangle]
pub extern "C" fn sprite_draw(id: i32, opacity: f32, sigma: f32) {
    let (w, h) = (st().w, st().h);
    sprite_draw_clip(id, opacity, sigma, 0.0, 0.0, w as f32, h as f32);
}

/// sprite_draw, limited to the frame rectangle [cx0, cx1) x [cy0, cy1) (rounded to whole pixels):
/// the template's clip-path wipes.
#[no_mangle]
pub extern "C" fn sprite_draw_clip(id: i32, opacity: f32, sigma: f32, cx0: f32, cy0: f32, cx1: f32, cy1: f32) {
    if opacity <= 0.0 { return; }
    let s = st();
    let (W, H) = (s.w, s.h);
    let sp = &s.sprites[id as usize];
    let (w, h) = (sp.pix.width() as usize, sp.pix.height() as usize);
    let (sx, sy) = (sp.x, sp.y);
    // Clip to the frame and the clip rectangle once (in sprite pixels), then blend whole rows.
    let cx0 = (cx0.round() as i32).max(0);
    let cy0 = (cy0.round() as i32).max(0);
    let cx1 = (cx1.round() as i32).min(W as i32);
    let cy1 = (cy1.round() as i32).min(H as i32);
    let x0 = (cx0 - sx).max(0) as usize;
    let x1 = ((cx1 - sx).min(w as i32)).max(0) as usize;
    let y0 = (cy0 - sy).max(0) as usize;
    let y1 = ((cy1 - sy).min(h as i32)).max(0) as usize;
    if x1 <= x0 || y1 <= y0 { return; }
    let src: &[u8] = if sigma > 0.05 {
        s.scratch.clear();
        s.scratch.extend_from_slice(sp.pix.data());
        box_blur(&mut s.scratch, &mut s.scratch2, &mut s.prefix, w, h, sigma);
        &s.scratch
    } else {
        sp.pix.data()
    };
    let op = (opacity.clamp(0.0, 1.0) * 256.0) as u16;
    let out = s.frame.data_mut();
    for y in y0..y1 {
        let fy = (sy + y as i32) as usize;
        let fx0 = (sx + x0 as i32) as usize;
        let d = &mut out[(fy * W + fx0) * 4..(fy * W + fx0 + (x1 - x0)) * 4];
        blend_row(d, &src[(y * w + x0) * 4..(y * w + x1) * 4], op);
    }
    mark_rect(s, (sx + x0 as i32) as f32, (sy + y0 as i32) as f32, (sx + x1 as i32) as f32, (sy + y1 as i32) as f32);
}

/// A sprite's premultiplied RGBA pixels, for content drawn in JS (gradients).
#[no_mangle]
pub extern "C" fn sprite_ptr(id: i32) -> *mut u8 {
    st().sprites[id as usize].pix.data_mut().as_mut_ptr()
}

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
            dst[i * 4 + ch] = (sv + (dst[i * 4 + ch] as u32 * (255 - a) + 127) / 255) as u8;
        }
    }
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
