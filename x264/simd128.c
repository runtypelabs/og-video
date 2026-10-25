// wasm SIMD128 versions of x264's hottest C kernels, for the functions x264 builds with
// --disable-asm (its asm is x86/ARM only). Each one matches the C function it replaces bit for bit,
// including int16 wrap-around where the C stores to dctcoef, so the encoded stream is unchanged.
// Hooked in by simd128.patch, after x264's own init functions have installed the C versions;
// check.c tests each against the C. GPL-2.0-or-later, as part of the x264 build (x264/COPYING).
#include <wasm_simd128.h>
#include "common/common.h"

typedef v128_t v;

static inline v load(const void *p) { return wasm_v128_load(p); }
static inline void store(void *p, v x) { wasm_v128_store(p, x); }
static inline v load8(const void *p) { return wasm_v128_load64_zero(p); }
static inline v load8x2(const void *p0, const void *p1) { return wasm_v128_load64_lane(p1, wasm_v128_load64_zero(p0), 1); }
static inline void store8(void *p, v x) { wasm_v128_store64_lane(p, x, 0); }
static inline v absdiff(v a, v b) { return wasm_v128_or(wasm_u8x16_sub_sat(a, b), wasm_u8x16_sub_sat(b, a)); }
static inline v sad_acc(v acc, v a, v b) { return wasm_i16x8_add(acc, wasm_u16x8_extadd_pairwise_u8x16(absdiff(a, b))); }
static inline int hsum16(v acc)
{
    v s = wasm_u32x4_extadd_pairwise_u16x8(acc);
    s = wasm_i32x4_add(s, wasm_i32x4_shuffle(s, s, 2, 3, 0, 1));
    s = wasm_i32x4_add(s, wasm_i32x4_shuffle(s, s, 1, 0, 3, 2));
    return wasm_i32x4_extract_lane(s, 0);
}

/* ---------------------------------------------------------------- SAD */

#define SAD16(h) \
static int sad_16x##h( pixel *p1, intptr_t s1, pixel *p2, intptr_t s2 ) \
{ \
    v acc = wasm_i16x8_splat(0); \
    for( int y = 0; y < h; y++, p1 += s1, p2 += s2 ) \
        acc = sad_acc( acc, load(p1), load(p2) ); \
    return hsum16( acc ); \
}
SAD16(16)
SAD16(8)

#define SAD8(h) \
static int sad_8x##h( pixel *p1, intptr_t s1, pixel *p2, intptr_t s2 ) \
{ \
    v acc = wasm_i16x8_splat(0); \
    for( int y = 0; y < h; y += 2, p1 += 2*s1, p2 += 2*s2 ) \
        acc = sad_acc( acc, load8x2(p1, p1+s1), load8x2(p2, p2+s2) ); \
    return hsum16( acc ); \
}
SAD8(16)
SAD8(8)
SAD8(4)

#define SAD_X(w, h, load2) \
static void sad_x3_##w##x##h( pixel *fenc, pixel *p0, pixel *p1, pixel *p2, intptr_t s, int scores[3] ) \
{ \
    v a0 = wasm_i16x8_splat(0), a1 = a0, a2 = a0; \
    for( int y = 0; y < h; y += ROWS, fenc += ROWS*FENC_STRIDE, p0 += ROWS*s, p1 += ROWS*s, p2 += ROWS*s ) \
    { \
        v f = load2( fenc, FENC_STRIDE ); \
        a0 = sad_acc( a0, f, load2( p0, s ) ); \
        a1 = sad_acc( a1, f, load2( p1, s ) ); \
        a2 = sad_acc( a2, f, load2( p2, s ) ); \
    } \
    scores[0] = hsum16( a0 ); scores[1] = hsum16( a1 ); scores[2] = hsum16( a2 ); \
} \
static void sad_x4_##w##x##h( pixel *fenc, pixel *p0, pixel *p1, pixel *p2, pixel *p3, intptr_t s, int scores[4] ) \
{ \
    v a0 = wasm_i16x8_splat(0), a1 = a0, a2 = a0, a3 = a0; \
    for( int y = 0; y < h; y += ROWS, fenc += ROWS*FENC_STRIDE, p0 += ROWS*s, p1 += ROWS*s, p2 += ROWS*s, p3 += ROWS*s ) \
    { \
        v f = load2( fenc, FENC_STRIDE ); \
        a0 = sad_acc( a0, f, load2( p0, s ) ); \
        a1 = sad_acc( a1, f, load2( p1, s ) ); \
        a2 = sad_acc( a2, f, load2( p2, s ) ); \
        a3 = sad_acc( a3, f, load2( p3, s ) ); \
    } \
    scores[0] = hsum16( a0 ); scores[1] = hsum16( a1 ); scores[2] = hsum16( a2 ); scores[3] = hsum16( a3 ); \
}
#define LOAD_W16(p, s) load(p)
#define LOAD_W8(p, s) load8x2(p, (p)+(s))
#define ROWS 1
SAD_X(16, 16, LOAD_W16)
SAD_X(16, 8, LOAD_W16)
#undef ROWS
#define ROWS 2
SAD_X(8, 16, LOAD_W8)
SAD_X(8, 8, LOAD_W8)
SAD_X(8, 4, LOAD_W8)
#undef ROWS

/* Same results, and the same side effect, as the C version: predict V, H and DC into fdec in turn
 * and SAD each against fenc, so fdec is left holding the DC prediction. */
static void intra_sad_x3_16x16( pixel *fenc, pixel *fdec, int res[3] )
{
    v top = load( fdec - FDEC_STRIDE );
    int dc = 0;
    for( int i = 0; i < 16; i++ )
        dc += fdec[-1 + i*FDEC_STRIDE] + fdec[i - FDEC_STRIDE];
    v vdc = wasm_i8x16_splat( (dc + 16) >> 5 );
    v av = wasm_i16x8_splat(0), ah = av, ad = av;
    for( int i = 0; i < 16; i++ )
    {
        v f = load( fenc + i*FENC_STRIDE );
        av = sad_acc( av, top, f );
        ah = sad_acc( ah, wasm_i8x16_splat( fdec[-1 + i*FDEC_STRIDE] ), f );
        ad = sad_acc( ad, vdc, f );
    }
    for( int i = 0; i < 16; i++ )
        store( fdec + i*FDEC_STRIDE, vdc );
    res[0] = hsum16( av );
    res[1] = hsum16( ah );
    res[2] = hsum16( ad );
}

/* ---------------------------------------------------------------- MC */

static void copy_w16( pixel *dst, intptr_t i_dst, pixel *src, intptr_t i_src, int h )
{
    for( int y = 0; y < h; y++, dst += i_dst, src += i_src )
        store( dst, load(src) );
}
static void copy_w8( pixel *dst, intptr_t i_dst, pixel *src, intptr_t i_src, int h )
{
    for( int y = 0; y < h; y++, dst += i_dst, src += i_src )
        store8( dst, load8(src) );
}
static void copy_w4( pixel *dst, intptr_t i_dst, pixel *src, intptr_t i_src, int h )
{
    for( int y = 0; y < h; y++, dst += i_dst, src += i_src )
        memcpy( dst, src, 4 );
}

static inline void copy_wxh( pixel *dst, intptr_t i_dst, pixel *src, intptr_t i_src, int w, int h )
{
    if( w == 16 ) copy_w16( dst, i_dst, src, i_src, h );
    else if( w == 8 ) copy_w8( dst, i_dst, src, i_src, h );
    else if( w == 4 ) copy_w4( dst, i_dst, src, i_src, h );
    else
        for( int y = 0; y < h; y++, dst += i_dst, src += i_src )
            memcpy( dst, src, w );
}

/* dst = (a + b + 1) >> 1, which is exactly u8x16.avgr. */
static inline void avg_wxh( pixel *dst, intptr_t i_dst, pixel *a, intptr_t i_a, pixel *b, intptr_t i_b, int w, int h )
{
    for( int y = 0; y < h; y++, dst += i_dst, a += i_a, b += i_b )
    {
        int x = 0;
        for( ; x + 16 <= w; x += 16 )
            store( dst+x, wasm_u8x16_avgr( load(a+x), load(b+x) ) );
        for( ; x + 8 <= w; x += 8 )
            store8( dst+x, wasm_u8x16_avgr( load8(a+x), load8(b+x) ) );
        for( ; x < w; x++ )
            dst[x] = ( a[x] + b[x] + 1 ) >> 1;
    }
}

#define AVG(w, h) \
static void avg_##w##x##h( pixel *dst, intptr_t i_dst, pixel *a, intptr_t i_a, pixel *b, intptr_t i_b, int weight ) \
{ \
    if( weight == 32 ) avg_wxh( dst, i_dst, a, i_a, b, i_b, w, h ); \
    else c_avg_##w##x##h( dst, i_dst, a, i_a, b, i_b, weight ); \
}
/* The C versions, for implicit weighted bipred (weight != 32). */
static void (*c_avg_16x16)( pixel *, intptr_t, pixel *, intptr_t, pixel *, intptr_t, int );
static void (*c_avg_16x8)( pixel *, intptr_t, pixel *, intptr_t, pixel *, intptr_t, int );
static void (*c_avg_8x16)( pixel *, intptr_t, pixel *, intptr_t, pixel *, intptr_t, int );
static void (*c_avg_8x8)( pixel *, intptr_t, pixel *, intptr_t, pixel *, intptr_t, int );
static void (*c_avg_8x4)( pixel *, intptr_t, pixel *, intptr_t, pixel *, intptr_t, int );
AVG(16, 16)
AVG(16, 8)
AVG(8, 16)
AVG(8, 8)
AVG(8, 4)

static void mc_luma( pixel *dst, intptr_t i_dst_stride, pixel *src[4], intptr_t i_src_stride,
                     int mvx, int mvy, int i_width, int i_height, const x264_weight_t *weight )
{
    int qpel_idx = ((mvy&3)<<2) + (mvx&3);
    int offset = (mvy>>2)*i_src_stride + (mvx>>2);
    pixel *src1 = src[x264_hpel_ref0[qpel_idx]] + offset + ((mvy&3) == 3) * i_src_stride;

    if( qpel_idx & 5 )
    {
        pixel *src2 = src[x264_hpel_ref1[qpel_idx]] + offset + ((mvx&3) == 3);
        avg_wxh( dst, i_dst_stride, src1, i_src_stride, src2, i_src_stride, i_width, i_height );
        if( weight->weightfn )
            weight->weightfn[i_width>>2]( dst, i_dst_stride, dst, i_dst_stride, weight, i_height );
    }
    else if( weight->weightfn )
        weight->weightfn[i_width>>2]( dst, i_dst_stride, src1, i_src_stride, weight, i_height );
    else
        copy_wxh( dst, i_dst_stride, src1, i_src_stride, i_width, i_height );
}

static pixel *get_ref( pixel *dst, intptr_t *i_dst_stride, pixel *src[4], intptr_t i_src_stride,
                       int mvx, int mvy, int i_width, int i_height, const x264_weight_t *weight )
{
    int qpel_idx = ((mvy&3)<<2) + (mvx&3);
    int offset = (mvy>>2)*i_src_stride + (mvx>>2);
    pixel *src1 = src[x264_hpel_ref0[qpel_idx]] + offset + ((mvy&3) == 3) * i_src_stride;

    if( qpel_idx & 5 )
    {
        pixel *src2 = src[x264_hpel_ref1[qpel_idx]] + offset + ((mvx&3) == 3);
        avg_wxh( dst, *i_dst_stride, src1, i_src_stride, src2, i_src_stride, i_width, i_height );
        if( weight->weightfn )
            weight->weightfn[i_width>>2]( dst, *i_dst_stride, dst, *i_dst_stride, weight, i_height );
        return dst;
    }
    else if( weight->weightfn )
    {
        weight->weightfn[i_width>>2]( dst, *i_dst_stride, src1, i_src_stride, weight, i_height );
        return dst;
    }
    *i_dst_stride = i_src_stride;
    return src1;
}

/* Bilinear chroma from NV12. Every term is at most 64*255+32, so 16-bit lanes are exact. */
static void (*c_mc_chroma)( pixel *, pixel *, intptr_t, pixel *, intptr_t, int, int, int, int );
static void mc_chroma( pixel *dstu, pixel *dstv, intptr_t i_dst, pixel *src, intptr_t i_src,
                       int mvx, int mvy, int i_width, int i_height )
{
    if( i_width != 8 )
    {
        c_mc_chroma( dstu, dstv, i_dst, src, i_src, mvx, mvy, i_width, i_height );
        return;
    }
    int d8x = mvx&7, d8y = mvy&7;
    v cA = wasm_i16x8_splat( (8-d8x)*(8-d8y) ), cB = wasm_i16x8_splat( d8x*(8-d8y) );
    v cC = wasm_i16x8_splat( (8-d8x)*d8y ),     cD = wasm_i16x8_splat( d8x*d8y );
    v r32 = wasm_i16x8_splat( 32 );
    src += (mvy >> 3) * i_src + (mvx >> 3)*2;
    v a = load( src ), b = load( src+2 );
    for( int y = 0; y < i_height; y++, dstu += i_dst, dstv += i_dst )
    {
        src += i_src;
        v c = load( src ), d = load( src+2 );
        v lo = wasm_i16x8_add( wasm_i16x8_add( wasm_i16x8_mul( cA, wasm_u16x8_extend_low_u8x16(a) ), wasm_i16x8_mul( cB, wasm_u16x8_extend_low_u8x16(b) ) ),
                               wasm_i16x8_add( wasm_i16x8_mul( cC, wasm_u16x8_extend_low_u8x16(c) ), wasm_i16x8_mul( cD, wasm_u16x8_extend_low_u8x16(d) ) ) );
        v hi = wasm_i16x8_add( wasm_i16x8_add( wasm_i16x8_mul( cA, wasm_u16x8_extend_high_u8x16(a) ), wasm_i16x8_mul( cB, wasm_u16x8_extend_high_u8x16(b) ) ),
                               wasm_i16x8_add( wasm_i16x8_mul( cC, wasm_u16x8_extend_high_u8x16(c) ), wasm_i16x8_mul( cD, wasm_u16x8_extend_high_u8x16(d) ) ) );
        lo = wasm_u16x8_shr( wasm_i16x8_add( lo, r32 ), 6 );
        hi = wasm_u16x8_shr( wasm_i16x8_add( hi, r32 ), 6 );
        v uv = wasm_u8x16_narrow_i16x8( lo, hi );
        v out = wasm_i8x16_shuffle( uv, uv, 0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11, 13, 15 );
        store8( dstu, out );
        wasm_v128_store64_lane( dstv, out, 1 );
        a = c; b = d;
    }
}

static void store_interleave_chroma( pixel *dst, intptr_t i_dst, pixel *srcu, pixel *srcv, int height )
{
    for( int y = 0; y < height; y++, dst += i_dst, srcu += FDEC_STRIDE, srcv += FDEC_STRIDE )
    {
        v u = load8( srcu ), w = load8( srcv );
        store( dst, wasm_i8x16_shuffle( u, w, 0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23 ) );
    }
}

static inline v deinterleave( v s ) { return wasm_i8x16_shuffle( s, s, 0, 2, 4, 6, 8, 10, 12, 14, 1, 3, 5, 7, 9, 11, 13, 15 ); }

static void load_deinterleave_chroma_fenc( pixel *dst, pixel *src, intptr_t i_src, int height )
{
    for( int y = 0; y < height; y++, dst += FENC_STRIDE, src += i_src )
        store( dst, deinterleave( load(src) ) );
}

static void load_deinterleave_chroma_fdec( pixel *dst, pixel *src, intptr_t i_src, int height )
{
    for( int y = 0; y < height; y++, dst += FDEC_STRIDE, src += i_src )
    {
        v d = deinterleave( load(src) );
        store8( dst, d );
        wasm_v128_store64_lane( dst + FDEC_STRIDE/2, d, 1 );
    }
}

/* ---------------------------------------------------------------- DCT */

/* The 4x4 forward transform of two side-by-side blocks (rows r0..r3, 8 lanes each). Vertical then
 * horizontal rather than the C's horizontal then vertical: the transform is linear and no stage
 * leaves int16 (|diff| <= 255, so every stage stays within 36*255), so the results are identical. */
static inline void dct4_pair( dctcoef *outa, dctcoef *outb, v r0, v r1, v r2, v r3 )
{
    v s03 = wasm_i16x8_add( r0, r3 ), d03 = wasm_i16x8_sub( r0, r3 );
    v s12 = wasm_i16x8_add( r1, r2 ), d12 = wasm_i16x8_sub( r1, r2 );
    v v0 = wasm_i16x8_add( s03, s12 );
    v v1 = wasm_i16x8_add( wasm_i16x8_shl( d03, 1 ), d12 );
    v v2 = wasm_i16x8_sub( s03, s12 );
    v v3 = wasm_i16x8_sub( d03, wasm_i16x8_shl( d12, 1 ) );
    /* Transpose: p_x = [v0..v3 at x | v0..v3 at x+4]. */
    v t0 = wasm_i16x8_shuffle( v0, v1, 0, 8, 1, 9, 2, 10, 3, 11 );
    v t1 = wasm_i16x8_shuffle( v0, v1, 4, 12, 5, 13, 6, 14, 7, 15 );
    v t2 = wasm_i16x8_shuffle( v2, v3, 0, 8, 1, 9, 2, 10, 3, 11 );
    v t3 = wasm_i16x8_shuffle( v2, v3, 4, 12, 5, 13, 6, 14, 7, 15 );
    v u0 = wasm_i32x4_shuffle( t0, t2, 0, 4, 1, 5 );
    v u1 = wasm_i32x4_shuffle( t0, t2, 2, 6, 3, 7 );
    v u2 = wasm_i32x4_shuffle( t1, t3, 0, 4, 1, 5 );
    v u3 = wasm_i32x4_shuffle( t1, t3, 2, 6, 3, 7 );
    v p0 = wasm_i64x2_shuffle( u0, u2, 0, 2 );
    v p1 = wasm_i64x2_shuffle( u0, u2, 1, 3 );
    v p2 = wasm_i64x2_shuffle( u1, u3, 0, 2 );
    v p3 = wasm_i64x2_shuffle( u1, u3, 1, 3 );
    s03 = wasm_i16x8_add( p0, p3 ); d03 = wasm_i16x8_sub( p0, p3 );
    s12 = wasm_i16x8_add( p1, p2 ); d12 = wasm_i16x8_sub( p1, p2 );
    v o0 = wasm_i16x8_add( s03, s12 );
    v o1 = wasm_i16x8_add( wasm_i16x8_shl( d03, 1 ), d12 );
    v o2 = wasm_i16x8_sub( s03, s12 );
    v o3 = wasm_i16x8_sub( d03, wasm_i16x8_shl( d12, 1 ) );
    /* Row u of each block: low half block a, high half block b. */
    store( outa,     wasm_i64x2_shuffle( o0, o1, 0, 2 ) );
    store( outa + 8, wasm_i64x2_shuffle( o2, o3, 0, 2 ) );
    if( outb )
    {
        store( outb,     wasm_i64x2_shuffle( o0, o1, 1, 3 ) );
        store( outb + 8, wasm_i64x2_shuffle( o2, o3, 1, 3 ) );
    }
}

static inline v diff8( pixel *p1, pixel *p2 )
{
    return wasm_i16x8_sub( wasm_u16x8_load8x8( p1 ), wasm_u16x8_load8x8( p2 ) );
}

static void sub4x4_dct( dctcoef dct[16], pixel *pix1, pixel *pix2 )
{
    v r[4];
    for( int y = 0; y < 4; y++ )
        r[y] = wasm_i16x8_sub( wasm_u16x8_extend_low_u8x16( wasm_v128_load32_zero( pix1 + y*FENC_STRIDE ) ),
                               wasm_u16x8_extend_low_u8x16( wasm_v128_load32_zero( pix2 + y*FDEC_STRIDE ) ) );
    dct4_pair( dct, NULL, r[0], r[1], r[2], r[3] );
}

static void sub8x8_dct( dctcoef dct[4][16], pixel *pix1, pixel *pix2 )
{
    for( int half = 0; half < 2; half++, pix1 += 4*FENC_STRIDE, pix2 += 4*FDEC_STRIDE )
        dct4_pair( dct[2*half], dct[2*half+1],
                   diff8( pix1, pix2 ), diff8( pix1 + FENC_STRIDE, pix2 + FDEC_STRIDE ),
                   diff8( pix1 + 2*FENC_STRIDE, pix2 + 2*FDEC_STRIDE ), diff8( pix1 + 3*FENC_STRIDE, pix2 + 3*FDEC_STRIDE ) );
}

static void sub16x16_dct( dctcoef dct[16][16], pixel *pix1, pixel *pix2 )
{
    sub8x8_dct( &dct[ 0], &pix1[0], &pix2[0] );
    sub8x8_dct( &dct[ 4], &pix1[8], &pix2[8] );
    sub8x8_dct( &dct[ 8], &pix1[8*FENC_STRIDE+0], &pix2[8*FDEC_STRIDE+0] );
    sub8x8_dct( &dct[12], &pix1[8*FENC_STRIDE+8], &pix2[8*FDEC_STRIDE+8] );
}

/* Inverse transform of two side-by-side blocks, added to an 8-wide strip of p_dst. The first pass
 * is the C's, in int16 (it stores to dctcoef too); the second is in int32, as the C computes it. */
static inline void idct4_pair( pixel *p_dst, int w8, const dctcoef *a, const dctcoef *b )
{
    /* Row k of each block (4 coefficients): low half a, high half b (or a again for one block). */
    v k0 = wasm_i64x2_shuffle( load8( a + 0 ),  load8( b + 0 ),  0, 2 );
    v k1 = wasm_i64x2_shuffle( load8( a + 4 ),  load8( b + 4 ),  0, 2 );
    v k2 = wasm_i64x2_shuffle( load8( a + 8 ),  load8( b + 8 ),  0, 2 );
    v k3 = wasm_i64x2_shuffle( load8( a + 12 ), load8( b + 12 ), 0, 2 );
    /* First pass, over k: x_i lanes are the other index. */
    v s02 = wasm_i16x8_add( k0, k2 ), d02 = wasm_i16x8_sub( k0, k2 );
    v s13 = wasm_i16x8_add( k1, wasm_i16x8_shr( k3, 1 ) );
    v d13 = wasm_i16x8_sub( wasm_i16x8_shr( k1, 1 ), k3 );
    v x0 = wasm_i16x8_add( s02, s13 );
    v x1 = wasm_i16x8_add( d02, d13 );
    v x2 = wasm_i16x8_sub( d02, d13 );
    v x3 = wasm_i16x8_sub( s02, s13 );
    /* Transpose to q_j = [block a's x0..x3 at lane j | block b's], i.e. one 8-pixel row's worth. */
    v t0 = wasm_i16x8_shuffle( x0, x1, 0, 8, 1, 9, 2, 10, 3, 11 );
    v t1 = wasm_i16x8_shuffle( x0, x1, 4, 12, 5, 13, 6, 14, 7, 15 );
    v t2 = wasm_i16x8_shuffle( x2, x3, 0, 8, 1, 9, 2, 10, 3, 11 );
    v t3 = wasm_i16x8_shuffle( x2, x3, 4, 12, 5, 13, 6, 14, 7, 15 );
    v u0 = wasm_i32x4_shuffle( t0, t2, 0, 4, 1, 5 );
    v u1 = wasm_i32x4_shuffle( t0, t2, 2, 6, 3, 7 );
    v u2 = wasm_i32x4_shuffle( t1, t3, 0, 4, 1, 5 );
    v u3 = wasm_i32x4_shuffle( t1, t3, 2, 6, 3, 7 );
    v q[4] = { wasm_i64x2_shuffle( u0, u2, 0, 2 ), wasm_i64x2_shuffle( u0, u2, 1, 3 ),
               wasm_i64x2_shuffle( u1, u3, 0, 2 ), wasm_i64x2_shuffle( u1, u3, 1, 3 ) };
    /* Second pass, over j, in int32: halves 0 and 1 are the low and high 4 lanes. */
    v r[4][2];
    v r32 = wasm_i32x4_splat( 32 );
    for( int h = 0; h < 2; h++ )
    {
        v q0 = h ? wasm_i32x4_extend_high_i16x8( q[0] ) : wasm_i32x4_extend_low_i16x8( q[0] );
        v q1 = h ? wasm_i32x4_extend_high_i16x8( q[1] ) : wasm_i32x4_extend_low_i16x8( q[1] );
        v q2 = h ? wasm_i32x4_extend_high_i16x8( q[2] ) : wasm_i32x4_extend_low_i16x8( q[2] );
        v q3 = h ? wasm_i32x4_extend_high_i16x8( q[3] ) : wasm_i32x4_extend_low_i16x8( q[3] );
        v S02 = wasm_i32x4_add( q0, q2 ), D02 = wasm_i32x4_sub( q0, q2 );
        v S13 = wasm_i32x4_add( q1, wasm_i32x4_shr( q3, 1 ) );
        v D13 = wasm_i32x4_sub( wasm_i32x4_shr( q1, 1 ), q3 );
        r[0][h] = wasm_i32x4_shr( wasm_i32x4_add( wasm_i32x4_add( S02, S13 ), r32 ), 6 );
        r[1][h] = wasm_i32x4_shr( wasm_i32x4_add( wasm_i32x4_add( D02, D13 ), r32 ), 6 );
        r[2][h] = wasm_i32x4_shr( wasm_i32x4_add( wasm_i32x4_sub( D02, D13 ), r32 ), 6 );
        r[3][h] = wasm_i32x4_shr( wasm_i32x4_add( wasm_i32x4_sub( S02, S13 ), r32 ), 6 );
    }
    for( int y = 0; y < 4; y++, p_dst += FDEC_STRIDE )
    {
        /* d is stored as dctcoef in the C: keep its low 16 bits, then add with clipping. */
        v d = wasm_i16x8_shuffle( r[y][0], r[y][1], 0, 2, 4, 6, 8, 10, 12, 14 );
        v px = w8 ? wasm_u16x8_load8x8( p_dst ) : wasm_u16x8_extend_low_u8x16( wasm_v128_load32_zero( p_dst ) );
        v sum = wasm_i32x4_add( wasm_i32x4_extend_low_i16x8( px ), wasm_i32x4_extend_low_i16x8( d ) );
        v sum2 = wasm_i32x4_add( wasm_i32x4_extend_high_i16x8( px ), wasm_i32x4_extend_high_i16x8( d ) );
        v out = wasm_u8x16_narrow_i16x8( wasm_i16x8_narrow_i32x4( sum, sum2 ), wasm_i16x8_splat(0) );
        if( w8 ) store8( p_dst, out );
        else wasm_v128_store32_lane( p_dst, out, 0 );
    }
}

static void add4x4_idct( pixel *p_dst, dctcoef dct[16] )
{
    idct4_pair( p_dst, 0, dct, dct );
}

static void add8x8_idct( pixel *p_dst, dctcoef dct[4][16] )
{
    idct4_pair( p_dst,                 1, dct[0], dct[1] );
    idct4_pair( p_dst + 4*FDEC_STRIDE, 1, dct[2], dct[3] );
}

static void add16x16_idct( pixel *p_dst, dctcoef dct[16][16] )
{
    add8x8_idct( &p_dst[0],               &dct[0] );
    add8x8_idct( &p_dst[8],               &dct[4] );
    add8x8_idct( &p_dst[8*FDEC_STRIDE+0], &dct[8] );
    add8x8_idct( &p_dst[8*FDEC_STRIDE+8], &dct[12] );
}

/* ---------------------------------------------------------------- quant */

/* QUANT_ONE on 8 coefficients: c > 0 ? (f + c) * mf >> 16 : -((f - c) * mf >> 16), in uint32 (so
 * the product wraps as the C's does), stored to int16. Returns the 8 results. */
static inline v quant8( dctcoef *dct, const udctcoef *mf, const udctcoef *bias )
{
    v c = load( dct ), m = load( mf ), f = load( bias );
    v a = wasm_i16x8_abs( c ); /* as uint16: |c|, including 32768 */
    v lo = wasm_i32x4_mul( wasm_i32x4_add( wasm_u32x4_extend_low_u16x8( f ), wasm_u32x4_extend_low_u16x8( a ) ), wasm_u32x4_extend_low_u16x8( m ) );
    v hi = wasm_i32x4_mul( wasm_i32x4_add( wasm_u32x4_extend_high_u16x8( f ), wasm_u32x4_extend_high_u16x8( a ) ), wasm_u32x4_extend_high_u16x8( m ) );
    v t = wasm_i16x8_shuffle( wasm_u32x4_shr( lo, 16 ), wasm_u32x4_shr( hi, 16 ), 0, 2, 4, 6, 8, 10, 12, 14 );
    v r = wasm_v128_bitselect( t, wasm_i16x8_neg( t ), wasm_i16x8_gt( c, wasm_i16x8_splat(0) ) );
    store( dct, r );
    return r;
}

static int quant_4x4( dctcoef dct[16], udctcoef mf[16], udctcoef bias[16] )
{
    v nz = wasm_v128_or( quant8( dct, mf, bias ), quant8( dct+8, mf+8, bias+8 ) );
    return wasm_v128_any_true( nz );
}

static int quant_4x4x4( dctcoef dct[4][16], udctcoef mf[16], udctcoef bias[16] )
{
    int nza = 0;
    for( int j = 0; j < 4; j++ )
    {
        v nz = wasm_v128_or( quant8( dct[j], mf, bias ), quant8( dct[j]+8, mf+8, bias+8 ) );
        nza |= wasm_v128_any_true( nz ) << j;
    }
    return nza;
}

static int quant_8x8( dctcoef dct[64], udctcoef mf[64], udctcoef bias[64] )
{
    v nz = wasm_i16x8_splat(0);
    for( int i = 0; i < 64; i += 8 )
        nz = wasm_v128_or( nz, quant8( dct+i, mf+i, bias+i ) );
    return wasm_v128_any_true( nz );
}

/* ---------------------------------------------------------------- coefficient scans */

/* Bit i set when coefficient i is nonzero, for exactly n (4, 8, 15 or 16) coefficients. */
static inline int nz_mask( const dctcoef *l, int n )
{
    v z = wasm_i16x8_splat(0);
    if( n == 4 )
        return wasm_i16x8_bitmask( wasm_i16x8_ne( load8( l ), z ) ) & 0xf;
    if( n == 8 )
        return wasm_i16x8_bitmask( wasm_i16x8_ne( load( l ), z ) );
    if( n == 15 )
        return wasm_i16x8_bitmask( wasm_i16x8_ne( load( l ), z ) ) | ( wasm_i16x8_bitmask( wasm_i16x8_ne( load( l+7 ), z ) ) << 7 );
    return wasm_i8x16_bitmask( wasm_i8x16_narrow_i16x8( wasm_i16x8_ne( load( l ), z ), wasm_i16x8_ne( load( l+8 ), z ) ) );
}

#define LAST(n) \
static int coeff_last##n( dctcoef *l ) \
{ \
    int m = nz_mask( l, n ); \
    return m ? 31 - __builtin_clz( m ) : -1; \
}
LAST(4)
LAST(8)
LAST(15)
LAST(16)

/* As the C: levels from the last nonzero coefficient down, the mask of nonzero positions. The C
 * starts from coeff_last, which is -1 for an all-zero block, and then still stores dct[-1]; it is
 * never called on one (callers check nnz first), and neither is this. */
#define LEVEL_RUN(n) \
static int coeff_level_run##n( dctcoef *dct, x264_run_level_t *runlevel ) \
{ \
    int m = nz_mask( dct, n ); \
    if( !m ) return c_level_run##n( dct, runlevel ); \
    int total = 0; \
    runlevel->last = 31 - __builtin_clz( m ); \
    runlevel->mask = m; \
    while( m ) \
    { \
        int i = 31 - __builtin_clz( m ); \
        runlevel->level[total++] = dct[i]; \
        m ^= 1 << i; \
    } \
    return total; \
}
static int (*c_level_run4)( dctcoef *, x264_run_level_t * );
static int (*c_level_run8)( dctcoef *, x264_run_level_t * );
static int (*c_level_run15)( dctcoef *, x264_run_level_t * );
static int (*c_level_run16)( dctcoef *, x264_run_level_t * );
LEVEL_RUN(4)
LEVEL_RUN(8)
LEVEL_RUN(15)
LEVEL_RUN(16)

/* As the C: 9 if any nonzero coefficient is not +-1, else the sum of the decimate table entry for
 * the run of zeros below each nonzero one. */
static inline int decimate_score( dctcoef *dct, int n )
{
    int m = nz_mask( dct, n );
    v one = wasm_i16x8_splat( 1 );
    /* |c| > 1 */
    v big = wasm_v128_or( wasm_i16x8_gt( wasm_i16x8_abs( load( dct ) ), one ), wasm_i16x8_lt( load( dct ), wasm_i16x8_splat( -32767 ) ) );
    int bigm = wasm_i16x8_bitmask( big );
    if( n == 16 )
    {
        v c = load( dct+8 );
        bigm |= wasm_i16x8_bitmask( wasm_v128_or( wasm_i16x8_gt( wasm_i16x8_abs( c ), one ), wasm_i16x8_lt( c, wasm_i16x8_splat( -32767 ) ) ) ) << 8;
    }
    else
    {
        v c = load( dct+7 );
        bigm |= wasm_i16x8_bitmask( wasm_v128_or( wasm_i16x8_gt( wasm_i16x8_abs( c ), one ), wasm_i16x8_lt( c, wasm_i16x8_splat( -32767 ) ) ) ) << 7;
    }
    if( bigm )
        return 9;
    int score = 0;
    while( m )
    {
        int i = 31 - __builtin_clz( m );
        m ^= 1 << i;
        int next = m ? 31 - __builtin_clz( m ) : -1;
        score += x264_decimate_table4[i - next - 1];
    }
    return score;
}

static int decimate_score15( dctcoef *dct ) { return decimate_score( dct+1, 15 ); }
static int decimate_score16( dctcoef *dct ) { return decimate_score( dct, 16 ); }

/* ---------------------------------------------------------------- init */

/* Set by check.c to get x264's C functions to compare against. */
int x264_wasm_simd_off;

void x264_wasm_pixel_init( x264_pixel_function_t *pixf )
{
    if( x264_wasm_simd_off )
        return;
    pixf->sad[PIXEL_16x16] = pixf->sad_aligned[PIXEL_16x16] = sad_16x16;
    pixf->sad[PIXEL_16x8]  = pixf->sad_aligned[PIXEL_16x8]  = sad_16x8;
    pixf->sad[PIXEL_8x16]  = pixf->sad_aligned[PIXEL_8x16]  = sad_8x16;
    pixf->sad[PIXEL_8x8]   = pixf->sad_aligned[PIXEL_8x8]   = sad_8x8;
    pixf->sad[PIXEL_8x4]   = pixf->sad_aligned[PIXEL_8x4]   = sad_8x4;
    pixf->sad_x3[PIXEL_16x16] = sad_x3_16x16;
    pixf->sad_x3[PIXEL_16x8]  = sad_x3_16x8;
    pixf->sad_x3[PIXEL_8x16]  = sad_x3_8x16;
    pixf->sad_x3[PIXEL_8x8]   = sad_x3_8x8;
    pixf->sad_x3[PIXEL_8x4]   = sad_x3_8x4;
    pixf->sad_x4[PIXEL_16x16] = sad_x4_16x16;
    pixf->sad_x4[PIXEL_16x8]  = sad_x4_16x8;
    pixf->sad_x4[PIXEL_8x16]  = sad_x4_8x16;
    pixf->sad_x4[PIXEL_8x8]   = sad_x4_8x8;
    pixf->sad_x4[PIXEL_8x4]   = sad_x4_8x4;
    pixf->intra_sad_x3_16x16 = intra_sad_x3_16x16;
}

void x264_wasm_mc_init( x264_mc_functions_t *pf )
{
    if( x264_wasm_simd_off )
        return;
    pf->mc_luma = mc_luma;
    pf->get_ref = get_ref;
    c_mc_chroma = pf->mc_chroma;
    pf->mc_chroma = mc_chroma;
    c_avg_16x16 = pf->avg[PIXEL_16x16]; pf->avg[PIXEL_16x16] = avg_16x16;
    c_avg_16x8  = pf->avg[PIXEL_16x8];  pf->avg[PIXEL_16x8]  = avg_16x8;
    c_avg_8x16  = pf->avg[PIXEL_8x16];  pf->avg[PIXEL_8x16]  = avg_8x16;
    c_avg_8x8   = pf->avg[PIXEL_8x8];   pf->avg[PIXEL_8x8]   = avg_8x8;
    c_avg_8x4   = pf->avg[PIXEL_8x4];   pf->avg[PIXEL_8x4]   = avg_8x4;
    pf->copy_16x16_unaligned = copy_w16;
    pf->copy[PIXEL_16x16] = copy_w16;
    pf->copy[PIXEL_8x8]   = copy_w8;
    pf->copy[PIXEL_4x4]   = copy_w4;
    pf->store_interleave_chroma       = store_interleave_chroma;
    pf->load_deinterleave_chroma_fenc = load_deinterleave_chroma_fenc;
    pf->load_deinterleave_chroma_fdec = load_deinterleave_chroma_fdec;
}

void x264_wasm_dct_init( x264_dct_function_t *dctf )
{
    if( x264_wasm_simd_off )
        return;
    dctf->sub4x4_dct    = sub4x4_dct;
    dctf->sub8x8_dct    = sub8x8_dct;
    dctf->sub16x16_dct  = sub16x16_dct;
    dctf->add4x4_idct   = add4x4_idct;
    dctf->add8x8_idct   = add8x8_idct;
    dctf->add16x16_idct = add16x16_idct;
}

void x264_wasm_quant_init( x264_quant_function_t *pf )
{
    if( x264_wasm_simd_off )
        return;
    pf->quant_4x4   = quant_4x4;
    pf->quant_4x4x4 = quant_4x4x4;
    pf->quant_8x8   = quant_8x8;
    pf->coeff_last4 = coeff_last4;
    pf->coeff_last8 = coeff_last8;
    pf->coeff_last[  DCT_LUMA_AC] = coeff_last15;
    pf->coeff_last[ DCT_LUMA_4x4] = coeff_last16;
    c_level_run4  = pf->coeff_level_run4;
    c_level_run8  = pf->coeff_level_run8;
    c_level_run15 = pf->coeff_level_run[  DCT_LUMA_AC];
    c_level_run16 = pf->coeff_level_run[ DCT_LUMA_4x4];
    pf->coeff_level_run4 = coeff_level_run4;
    pf->coeff_level_run8 = coeff_level_run8;
    pf->coeff_level_run[  DCT_LUMA_AC] = coeff_level_run15;
    pf->coeff_level_run[ DCT_LUMA_4x4] = coeff_level_run16;
    pf->decimate_score15 = decimate_score15;
    pf->decimate_score16 = decimate_score16;
}
