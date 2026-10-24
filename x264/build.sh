#!/bin/sh
# Builds x264 to wasm/x264.wasm (wasm32-wasi reactor, SIMD128, single thread). Needs zig (it is
# the C toolchain and linker), binaryen's wasm-opt and git. x264 is GPL-2.0-or-later: see x264/COPYING and NOTICE.md.
set -e
cd "$(dirname "$0")"
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
HERE=$(pwd)
[ -d src ] || git clone https://code.videolan.org/videolan/x264.git src
(cd src && git fetch -q origin && git checkout -q "$X264_COMMIT")
mkdir -p bin
printf '#!/bin/sh\nexec zig cc -target wasm32-wasi "$@"\n' > bin/wcc
printf '#!/bin/sh\nexec zig ar "$@"\n' > bin/war
printf '#!/bin/sh\nexec zig ranlib "$@"\n' > bin/wranlib
chmod +x bin/*
cd src
CC="$HERE/bin/wcc" AR="$HERE/bin/war" RANLIB="$HERE/bin/wranlib" ./configure \
  --host=i686-pc-linux-gnu --disable-asm --disable-cli --disable-thread --disable-opencl \
  --enable-static --bit-depth=8 --chroma-format=420 --disable-interlaced \
  --extra-cflags="-O3 -msimd128 -D_WASI_EMULATED_SIGNAL"
# wasi-libc has no memalign (x264 then uses posix_memalign), and configure's i686 host adds flags
# that are wrong for wasm: -m32, and -fno-tree-vectorize, which would forbid SIMD128 auto-vectorization.
sed -i.bak 's/#define HAVE_MALLOC_H 1/#define HAVE_MALLOC_H 0/' config.h
sed -i.bak -e 's/ -m32 / /' -e 's/ -fno-tree-vectorize / /' config.mak
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" libx264.a
cd ..
EXPORTS=""
for f in enc_open enc_input_ptr enc_out_ptr enc_out_key enc_out_pts enc_out_dts enc_encode enc_flush enc_headers enc_close wmalloc wfree enc_set_vfr enc_plane enc_stride enc_encode_yuv enc_mb_info; do
  EXPORTS="$EXPORTS -Wl,--export=$f"
done
# A 1 MB stack instead of zig's 16 MB default keeps the instance near 20 MB.
zig cc -target wasm32-wasi -mexec-model=reactor -O3 -msimd128 -Wl,-z,stack-size=1048576 -Isrc wrapper.c src/libx264.a $EXPORTS -o x264.unopt.wasm
wasm-opt -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals -g --strip-dwarf x264.unopt.wasm -o ../wasm/x264.wasm
rm x264.unopt.wasm
ls -l ../wasm/x264.wasm
