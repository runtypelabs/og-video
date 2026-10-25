// Checks every kernel in simd128.c against the x264 C function it replaces, on random and extreme
// inputs (x264's checkasm, for this file). Built and run by build.sh; exits non-zero on a mismatch.
#include <stdio.h>
#include <stdlib.h>
#include "common/common.h"

extern int x264_wasm_simd_off;

static uint32_t seed = 12345;
static uint32_t rnd( void ) { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return seed; }
/* Pixels: uniform, or all 0/255, or a narrow band, so saturating and clipping paths get hit. */
static void fill_pixels( pixel *p, int n )
{
    int mode = rnd() % 4;
    for( int i = 0; i < n; i++ )
        p[i] = mode == 0 ? rnd() : mode == 1 ? (rnd() & 1) * 255 : mode == 2 ? 120 + rnd() % 16 : (rnd() % 3 ? 0 : 255);
}
/* Coefficients: small, any int16, or sparse with +-1 and the odd large one. */
static void fill_coefs( dctcoef *d, int n, int mode )
{
    for( int i = 0; i < n; i++ )
    {
        uint32_t r = rnd();
        switch( mode % 5 )
        {
            case 0: d[i] = (int)(r % 512) - 256; break;
            case 1: d[i] = (int16_t)r; break;
            case 2: d[i] = r % 4 ? 0 : (r & 8 ? 1 : -1); break;
            case 3: d[i] = r % 3 ? 0 : (r % 7 ? (int)(r % 5) - 2 : (int16_t)(r >> 8)); break;
            default: d[i] = r % 9 ? 0 : (r & 16 ? -32768 : 32767); break;
        }
    }
}

static int fails = 0;
#define FAIL(...) do { if( fails++ < 20 ) printf( __VA_ARGS__ ); } while( 0 )

static x264_pixel_function_t pc, ps;
static x264_mc_functions_t mc, ms;
static x264_dct_function_t dc, ds;
static x264_quant_function_t qc, qs;

#define N 20000
static ALIGNED_16( pixel buf1[64*64] );
static ALIGNED_16( pixel buf2[64*64] );
static ALIGNED_16( pixel buf3[64*64] );
static ALIGNED_16( pixel buf4[64*64] );
static ALIGNED_16( pixel buf5[64*64] );

static void check_pixel( void )
{
    static const int sizes[] = { PIXEL_16x16, PIXEL_16x8, PIXEL_8x16, PIXEL_8x8, PIXEL_8x4 };
    for( int it = 0; it < N; it++ )
    {
        fill_pixels( buf1, sizeof(buf1) ); fill_pixels( buf2, sizeof(buf2) ); fill_pixels( buf3, sizeof(buf3) );
        fill_pixels( buf4, sizeof(buf4) ); fill_pixels( buf5, sizeof(buf5) );
        int s = sizes[it % 5];
        intptr_t st1 = 16 + rnd() % 33, st2 = 16 + rnd() % 33;
        pixel *a = buf1 + rnd() % 16, *b = buf2 + rnd() % 16;
        if( pc.sad[s]( a, st1, b, st2 ) != ps.sad[s]( a, st1, b, st2 ) )
            FAIL( "sad[%d]\n", s );
        if( pc.sad_aligned[s]( a, st1, b, st2 ) != ps.sad_aligned[s]( a, st1, b, st2 ) )
            FAIL( "sad_aligned[%d]\n", s );
        int r1[4], r2[4];
        pixel *p0 = buf2 + rnd() % 16, *p1 = buf3 + rnd() % 16, *p2 = buf4 + rnd() % 16, *p3 = buf5 + rnd() % 16;
        pc.sad_x3[s]( buf1, p0, p1, p2, st2, r1 ); ps.sad_x3[s]( buf1, p0, p1, p2, st2, r2 );
        if( memcmp( r1, r2, 3*sizeof(int) ) ) FAIL( "sad_x3[%d]\n", s );
        pc.sad_x4[s]( buf1, p0, p1, p2, p3, st2, r1 ); ps.sad_x4[s]( buf1, p0, p1, p2, p3, st2, r2 );
        if( memcmp( r1, r2, 4*sizeof(int) ) ) FAIL( "sad_x4[%d]\n", s );

        /* intra: fdec with its top row and left column */
        memcpy( buf3, buf2, sizeof(buf2) );
        pixel *fd2 = buf2 + FDEC_STRIDE + 16, *fd3 = buf3 + FDEC_STRIDE + 16;
        pc.intra_sad_x3_16x16( buf1, fd2, r1 ); ps.intra_sad_x3_16x16( buf1, fd3, r2 );
        if( memcmp( r1, r2, 3*sizeof(int) ) ) FAIL( "intra_sad_x3_16x16 %d %d %d / %d %d %d\n", r1[0], r1[1], r1[2], r2[0], r2[1], r2[2] );
        if( memcmp( buf2, buf3, sizeof(buf2) ) ) FAIL( "intra_sad_x3_16x16 fdec\n" );
    }
}

static void check_mc( void )
{
    static const int avgs[] = { PIXEL_16x16, PIXEL_16x8, PIXEL_8x16, PIXEL_8x8, PIXEL_8x4 };
    static ALIGNED_16( pixel planes[4][96*96] );
    for( int it = 0; it < N; it++ )
    {
        for( int i = 0; i < 4; i++ ) fill_pixels( planes[i], sizeof(planes[i]) );
        fill_pixels( buf1, sizeof(buf1) );
        memcpy( buf2, buf1, sizeof(buf1) );
        intptr_t sst = 48 + rnd() % 40, dst = 16 + rnd() % 33;

        /* copy */
        int c = (int[]){ PIXEL_16x16, PIXEL_8x8, PIXEL_4x4 }[it % 3];
        int h = 1 + rnd() % 16;
        pixel *src = planes[0] + 200 + rnd() % 100;
        mc.copy[c]( buf1, dst, src, sst, h ); ms.copy[c]( buf2, dst, src, sst, h );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "copy[%d]\n", c );
        mc.copy_16x16_unaligned( buf1, dst, src, sst, h ); ms.copy_16x16_unaligned( buf2, dst, src, sst, h );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "copy_16x16_unaligned\n" );

        /* avg, implicit weights included */
        int a = avgs[it % 5], w = it % 3 ? 32 : (int)(rnd() % 97) - 16;
        pixel *s1 = planes[1] + rnd() % 300, *s2 = planes[2] + rnd() % 300;
        mc.avg[a]( buf1, dst, s1, sst, s2, sst - 3, w ); ms.avg[a]( buf2, dst, s1, sst, s2, sst - 3, w );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "avg[%d] w=%d\n", a, w );

        /* mc_luma / get_ref, every qpel position, with and without weights */
        pixel *srcs[4] = { planes[0] + 40*sst + 40, planes[1] + 40*sst + 40, planes[2] + 40*sst + 40, planes[3] + 40*sst + 40 };
        int mvx = (int)(rnd() % 64) - 32, mvy = (int)(rnd() % 64) - 32;
        int bw = (int[]){ 4, 8, 16, 12, 20 }[rnd() % 5], bh = (int[]){ 4, 8, 16 }[rnd() % 3];
        x264_weight_t wt = { 0 };
        if( it % 4 == 0 )
        {
            wt.i_denom = rnd() % 7; wt.i_scale = rnd() % 128; wt.i_offset = (int)(rnd() % 256) - 128;
            wt.weightfn = mc.weight;
        }
        mc.mc_luma( buf1, dst, srcs, sst, mvx, mvy, bw, bh, &wt ); ms.mc_luma( buf2, dst, srcs, sst, mvx, mvy, bw, bh, &wt );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "mc_luma %dx%d mv %d,%d w=%d\n", bw, bh, mvx, mvy, !!wt.weightfn );
        intptr_t st1 = dst, st2 = dst;
        pixel *r1 = mc.get_ref( buf1, &st1, srcs, sst, mvx, mvy, bw, bh, &wt );
        pixel *r2 = ms.get_ref( buf2, &st2, srcs, sst, mvx, mvy, bw, bh, &wt );
        if( st1 != st2 || (r1 == buf1) != (r2 == buf2) || (r1 != buf1 && r1 != r2) || memcmp( buf1, buf2, sizeof(buf1) ) )
            FAIL( "get_ref %dx%d mv %d,%d\n", bw, bh, mvx, mvy );

        /* chroma */
        int cw = (int[]){ 2, 4, 8 }[rnd() % 3], ch = (int[]){ 2, 4, 8, 16 }[rnd() % 4];
        pixel *csrc = planes[3] + 30*sst + 40;
        mc.mc_chroma( buf1, buf1 + 8, dst, csrc, sst, mvx, mvy, cw, ch );
        ms.mc_chroma( buf2, buf2 + 8, dst, csrc, sst, mvx, mvy, cw, ch );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "mc_chroma %dx%d mv %d,%d\n", cw, ch, mvx, mvy );

        /* NV12 <-> planar */
        h = 1 + rnd() % 16;
        mc.store_interleave_chroma( buf1, dst, planes[1], planes[1] + FDEC_STRIDE/2, h );
        ms.store_interleave_chroma( buf2, dst, planes[1], planes[1] + FDEC_STRIDE/2, h );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "store_interleave_chroma\n" );
        mc.load_deinterleave_chroma_fenc( buf1, planes[2], sst, h ); ms.load_deinterleave_chroma_fenc( buf2, planes[2], sst, h );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "load_deinterleave_chroma_fenc\n" );
        mc.load_deinterleave_chroma_fdec( buf1, planes[2], sst, h ); ms.load_deinterleave_chroma_fdec( buf2, planes[2], sst, h );
        if( memcmp( buf1, buf2, sizeof(buf1) ) ) FAIL( "load_deinterleave_chroma_fdec\n" );
    }
}

static void check_dct( void )
{
    static ALIGNED_16( dctcoef d1[16][16] );
    static ALIGNED_16( dctcoef d2[16][16] );
    for( int it = 0; it < N; it++ )
    {
        fill_pixels( buf1, sizeof(buf1) ); fill_pixels( buf2, sizeof(buf2) );
        memset( d1, 0x55, sizeof(d1) ); memset( d2, 0x55, sizeof(d2) );
        dc.sub4x4_dct( d1[0], buf1, buf2 ); ds.sub4x4_dct( d2[0], buf1, buf2 );
        if( memcmp( d1, d2, sizeof(d1) ) ) FAIL( "sub4x4_dct\n" );
        dc.sub8x8_dct( d1, buf1, buf2 ); ds.sub8x8_dct( d2, buf1, buf2 );
        if( memcmp( d1, d2, sizeof(d1) ) ) FAIL( "sub8x8_dct\n" );
        dc.sub16x16_dct( d1, buf1, buf2 ); ds.sub16x16_dct( d2, buf1, buf2 );
        if( memcmp( d1, d2, sizeof(d1) ) ) FAIL( "sub16x16_dct\n" );

        fill_coefs( d1[0], 256, it );
        memcpy( d2, d1, sizeof(d1) );
        memcpy( buf3, buf2, sizeof(buf2) );
        pixel *p2 = buf2 + 4*FDEC_STRIDE + 8, *p3 = buf3 + 4*FDEC_STRIDE + 8;
        dc.add4x4_idct( p2, d1[0] ); ds.add4x4_idct( p3, d2[0] );
        if( memcmp( buf2, buf3, sizeof(buf2) ) || memcmp( d1, d2, sizeof(d1) ) ) FAIL( "add4x4_idct (mode %d)\n", it % 5 );
        dc.add8x8_idct( p2, d1 ); ds.add8x8_idct( p3, d2 );
        if( memcmp( buf2, buf3, sizeof(buf2) ) || memcmp( d1, d2, sizeof(d1) ) ) FAIL( "add8x8_idct (mode %d)\n", it % 5 );
        dc.add16x16_idct( p2, d1 ); ds.add16x16_idct( p3, d2 );
        if( memcmp( buf2, buf3, sizeof(buf2) ) || memcmp( d1, d2, sizeof(d1) ) ) FAIL( "add16x16_idct (mode %d)\n", it % 5 );
    }
}

static void check_quant( void )
{
    static ALIGNED_16( dctcoef d1[4][16] );
    static ALIGNED_16( dctcoef d2[4][16] );
    static ALIGNED_16( udctcoef mf[64] );
    static ALIGNED_16( udctcoef bias[64] );
    static ALIGNED_16( dctcoef e1[20] );
    static ALIGNED_16( dctcoef e2[20] );
    for( int it = 0; it < N; it++ )
    {
        for( int i = 0; i < 64; i++ )
        {
            mf[i] = it % 2 ? 1 + rnd() % 65535 : 1 + rnd() % 8192;
            bias[i] = it % 3 ? rnd() % 65536 : rnd() % 2048;
        }
        fill_coefs( d1[0], 64, it );
        memcpy( d2, d1, sizeof(d1) );
        int a = qc.quant_4x4( d1[0], mf, bias ), b = qs.quant_4x4( d2[0], mf, bias );
        if( a != b || memcmp( d1, d2, sizeof(d1) ) ) FAIL( "quant_4x4 (mode %d)\n", it % 5 );
        fill_coefs( d1[0], 64, it + 1 );
        memcpy( d2, d1, sizeof(d1) );
        a = qc.quant_4x4x4( d1, mf, bias ); b = qs.quant_4x4x4( d2, mf, bias );
        if( a != b || memcmp( d1, d2, sizeof(d1) ) ) FAIL( "quant_4x4x4 (mode %d)\n", it % 5 );
        fill_coefs( d1[0], 64, it + 2 );
        memcpy( d2, d1, sizeof(d1) );
        a = qc.quant_8x8( d1[0], mf, bias ); b = qs.quant_8x8( d2[0], mf, bias );
        if( a != b || memcmp( d1, d2, sizeof(d1) ) ) FAIL( "quant_8x8 (mode %d)\n", it % 5 );

        /* scans: e[0] and e[17..19] are guards, the block starts at e+1 */
        fill_coefs( e1, 20, (it % 4) + 2 );
        if( it % 7 == 0 ) memset( e1 + 1, 0, 16*sizeof(dctcoef) );
        dctcoef *blk = e1 + 1;
        if( qc.coeff_last4( blk ) != qs.coeff_last4( blk ) ) FAIL( "coeff_last4\n" );
        if( qc.coeff_last8( blk ) != qs.coeff_last8( blk ) ) FAIL( "coeff_last8\n" );
        if( qc.coeff_last[DCT_LUMA_AC]( blk ) != qs.coeff_last[DCT_LUMA_AC]( blk ) ) FAIL( "coeff_last15\n" );
        if( qc.coeff_last[DCT_LUMA_4x4]( blk ) != qs.coeff_last[DCT_LUMA_4x4]( blk ) ) FAIL( "coeff_last16\n" );
        if( qc.decimate_score15( blk ) != qs.decimate_score15( blk ) ) FAIL( "decimate_score15 %d %d\n", qc.decimate_score15( blk ), qs.decimate_score15( blk ) );
        if( qc.decimate_score16( blk ) != qs.decimate_score16( blk ) ) FAIL( "decimate_score16 %d %d\n", qc.decimate_score16( blk ), qs.decimate_score16( blk ) );
        int (*lr[4][2])( dctcoef *, x264_run_level_t * ) = {
            { qc.coeff_level_run4, qs.coeff_level_run4 }, { qc.coeff_level_run8, qs.coeff_level_run8 },
            { qc.coeff_level_run[DCT_LUMA_AC], qs.coeff_level_run[DCT_LUMA_AC] }, { qc.coeff_level_run[DCT_LUMA_4x4], qs.coeff_level_run[DCT_LUMA_4x4] } };
        int nn[4] = { 4, 8, 15, 16 };
        for( int k = 0; k < 4; k++ )
        {
            int any = 0;
            for( int i = 0; i < nn[k]; i++ ) any |= blk[i];
            if( !any ) continue; /* x264 never asks for runs of an empty block (the C reads dct[-1]) */
            x264_run_level_t rl1, rl2;
            memset( &rl1, 0x11, sizeof(rl1) ); memset( &rl2, 0x11, sizeof(rl2) );
            int t1 = lr[k][0]( blk, &rl1 ), t2 = lr[k][1]( blk, &rl2 );
            if( t1 != t2 || memcmp( &rl1, &rl2, sizeof(rl1) ) ) FAIL( "coeff_level_run%d\n", nn[k] );
        }
        (void)e2;
    }
}

int main( void )
{
    static x264_t h;
    x264_wasm_simd_off = 1;
    x264_pixel_init( 0, &pc ); x264_mc_init( 0, &mc, 0 ); x264_dct_init( 0, &dc ); x264_quant_init( &h, 0, &qc );
    x264_wasm_simd_off = 0;
    x264_pixel_init( 0, &ps ); x264_mc_init( 0, &ms, 0 ); x264_dct_init( 0, &ds ); x264_quant_init( &h, 0, &qs );
    if( pc.sad[PIXEL_16x16] == ps.sad[PIXEL_16x16] ) { printf( "SIMD kernels not installed\n" ); return 2; }
    check_pixel(); printf( "pixel done\n" );
    check_mc(); printf( "mc done\n" );
    check_dct(); printf( "dct done\n" );
    check_quant(); printf( "quant done\n" );
    printf( fails ? "%d mismatches\n" : "all kernels match the C\n", fails );
    return fails ? 1 : 0;
}
