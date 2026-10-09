#!/bin/sh
# Rebuilds the WebAssembly kernels of the neural stem engine (needs clang + wasm-ld, LLVM 15+).
cd "$(dirname "$0")"
F="--target=wasm32 -O3 -msimd128 -nostdlib -fno-builtin -Wl,--no-entry -Wl,--export-dynamic -Wl,--import-memory -Wl,--stack-first -Wl,-z,stack-size=262144 -Wl,--export=__heap_base"
clang $F -o kernels.wasm kernels.c && clang $F -mrelaxed-simd -DRELAXED -o kernels_fma.wasm kernels.c && ls -l *.wasm
