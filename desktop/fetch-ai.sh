#!/usr/bin/env bash
# Downloads the AI stem separator for the desktop build:
#  - ONNX Runtime Web (MIT, Microsoft), pinned to the build Rush is tested with
#  - HTDemucs v4 (MIT, Meta AI) as a single-file ONNX export (fp16 weights)
# A failed download leaves the app on its fast built-in separator; it never breaks the build.
set -u
cd "$(dirname "$0")"
rm -rf ai && mkdir -p ai/models ai/ort
ORT_REPO=https://github.com/microsoft/webnn-developer-preview
ORT_SHA=12e990b8fc4b8311ec5f869b24732b45241726c8
FILES="ort.all.min.js ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm"
ok=1
if git clone -q --filter=blob:none --no-checkout "$ORT_REPO" ortsrc && (cd ortsrc && git checkout -q "$ORT_SHA" -- $(for f in $FILES; do echo assets/dist/$f; done)); then
  for f in $FILES; do cp "ortsrc/assets/dist/$f" ai/ort/; done
else
  echo "::warning title=AI stems::Could not fetch ONNX Runtime Web"; ok=0
fi
rm -rf ortsrc
MODEL_URL=https://huggingface.co/adowu/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx
if [ $ok = 1 ] && curl -fsSL --retry 5 --retry-delay 10 -o ai/models/htdemucs.onnx "$MODEL_URL"; then
  size=$(wc -c < ai/models/htdemucs.onnx)
  if [ "$size" -lt 100000000 ]; then echo "::warning title=AI stems::Model download looks truncated ($size bytes)"; ok=0; fi
else
  echo "::warning title=AI stems::Could not download the HTDemucs model"; ok=0
fi
if [ $ok = 1 ]; then
  cat > ai/models/manifest.json <<JSON
{ "model": "htdemucs.onnx", "name": "HTDemucs v4", "sampleRate": 44100, "segment": 343980, "stems": ["drums", "bass", "other", "vocals"], "runtime": "ort.all.min.js" }
JSON
  cp ../THIRD_PARTY.md ai/ 2>/dev/null || true
  echo "::notice title=AI stems::Bundled HTDemucs ($(du -h ai/models/htdemucs.onnx | cut -f1)) and ONNX Runtime Web"
else
  rm -rf ai && mkdir -p ai
fi
exit 0
