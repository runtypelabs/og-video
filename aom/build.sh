#!/bin/sh
# Builds libaom (AV1, realtime encoder only) to wasm/aom.wasm (wasm32-wasi reactor, SIMD128 by
# auto-vectorization, single thread). Needs zig (C toolchain and linker), cmake, perl, binaryen's
# wasm-opt and git. libaom is BSD-2-Clause with the AOM patent license: see aom/LICENSE, aom/PATENTS.
set -e
cd "$(dirname "$0")"
AOM_TAG=v3.15.2
AOM_COMMIT=af3dc9aadc793c1b00edc003e3fc19a44fdeb574
HERE=$(pwd)
[ -d src ] || git clone https://aomedia.googlesource.com/aom src
(cd src && git fetch -q origin tag "$AOM_TAG" && git checkout -q "$AOM_COMMIT")
mkdir -p bin build
printf '#!/bin/sh\nexec zig cc -target wasm32-wasi "$@"\n' > bin/wcc
printf '#!/bin/sh\nexec zig c++ -target wasm32-wasi "$@"\n' > bin/wcxx
printf '#!/bin/sh\nexec zig ar "$@"\n' > bin/war
printf '#!/bin/sh\nexec zig ranlib "$@"\n' > bin/wranlib
chmod +x bin/*
# wasm32-wasi has no setjmp without the exception-handling proposal: shim/setjmp.h makes an
# internal libaom error trap instead (the instance is then discarded).
(cd build && cmake ../src -DCMAKE_SYSTEM_NAME=Generic -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_C_COMPILER="$HERE/bin/wcc" -DCMAKE_CXX_COMPILER="$HERE/bin/wcxx" -DCMAKE_AR="$HERE/bin/war" -DCMAKE_RANLIB="$HERE/bin/wranlib" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="-O3 -msimd128 -D_WASI_EMULATED_SIGNAL -I$HERE/shim" \
  -DAOM_TARGET_CPU=generic -DCONFIG_MULTITHREAD=0 -DCONFIG_AV1_DECODER=0 -DCONFIG_REALTIME_ONLY=1 \
  -DCONFIG_RUNTIME_CPU_DETECT=0 -DCONFIG_WEBM_IO=0 -DCONFIG_AV1_HIGHBITDEPTH=0 -DCONFIG_PIC=0 \
  -DCONFIG_TUNE_VMAF=0 -DCONFIG_TUNE_BUTTERAUGLI=0 -DCONFIG_OS_SUPPORT=0 \
  -DENABLE_TESTS=0 -DENABLE_EXAMPLES=0 -DENABLE_TOOLS=0 -DENABLE_DOCS=0 >/dev/null && \
  make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" aom >/dev/null)
EXPORTS=""
for f in enc_open enc_input_ptr enc_mb_info enc_out_ptr enc_out_key enc_out_pts enc_encode enc_flush enc_headers enc_close wmalloc wfree; do
  EXPORTS="$EXPORTS -Wl,--export=$f"
done
zig cc -target wasm32-wasi -mexec-model=reactor -O3 -msimd128 -Wl,-z,stack-size=1048576 -Isrc -Ibuild wrapper.c build/libaom.a $EXPORTS -o aom.unopt.wasm
wasm-opt -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals -g --strip-dwarf aom.unopt.wasm -o ../wasm/aom.wasm
rm aom.unopt.wasm
ls -l ../wasm/aom.wasm
