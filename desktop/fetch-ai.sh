#!/usr/bin/env bash
# Downloads the AI stem separator for the desktop build:
#  - ONNX Runtime Web (MIT, Microsoft), pinned to the build Rush is tested with
#  - HTDemucs v4 (MIT, Meta AI), forward-only ONNX export for ONNX Runtime Web (MIT)
# A failed download leaves the app on its fast built-in separator; it never breaks the build.
set -u
cd "$(dirname "$0")"
rm -rf ai && mkdir -p ai/models ai/ort
ORT_REPO=https://github.com/microsoft/webnn-developer-preview
ORT_SHA=12e990b8fc4b8311ec5f869b24732b45241726c8
FILES="ort.all.min.js ort.min.js ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm"
ok=1
for f in $FILES; do
  curl -fsSL --retry 5 --retry-delay 5 -o "ai/ort/$f" "https://raw.githubusercontent.com/microsoft/webnn-developer-preview/$ORT_SHA/assets/dist/$f" || { ok=0; break; }
done
if [ $ok = 0 ]; then   # fall back to git
  ok=1
  if git clone -q --filter=blob:none --no-checkout "$ORT_REPO" ortsrc 2>ort.log && (cd ortsrc && git checkout -q "$ORT_SHA" -- $(for f in $FILES; do echo assets/dist/$f; done)) 2>>ort.log; then
    for f in $FILES; do cp "ortsrc/assets/dist/$f" ai/ort/; done
  else
    echo "::warning title=AI stems::Could not fetch ONNX Runtime Web: $(tail -c 400 ort.log | tr '\n' ' ')"; ok=0
  fi
  rm -rf ortsrc ort.log
fi
# HTDemucs v4, forward-only export made for ONNX Runtime Web (spectrogram and its inverse run in Rush's own code)
HF=https://huggingface.co/webnn/stem-separator/resolve/main/onnx
if [ $ok = 1 ] && curl -fsSL --retry 5 --retry-delay 10 -o ai/models/htdemucs_fwd.onnx "$HF/htdemucs_fwd.onnx" && curl -fsSL --retry 5 --retry-delay 10 -o ai/models/htdemucs_fwd.onnx.data "$HF/htdemucs_fwd.onnx.data"; then
  size=$(wc -c < ai/models/htdemucs_fwd.onnx.data)
  if [ "$size" -lt 100000000 ]; then echo "::warning title=AI stems::Model download looks truncated ($size bytes)"; ok=0; fi
else
  echo "::warning title=AI stems::Could not download the HTDemucs model"; ok=0
fi
if [ $ok = 1 ]; then
  cat > ai/models/manifest.json <<JSON
{ "model": "htdemucs_fwd.onnx", "externalData": "htdemucs_fwd.onnx.data", "format": "htdemucs-fwd", "name": "HTDemucs v4", "sampleRate": 44100, "segment": 343980, "stems": ["drums", "bass", "other", "vocals"], "runtime": "ort.all.min.js" }
JSON
  cp ../THIRD_PARTY.md ai/ 2>/dev/null || true
  echo "::notice title=AI stems::Bundled HTDemucs ($(du -h ai/models/htdemucs_fwd.onnx.data | cut -f1)) and ONNX Runtime Web"
else
  rm -rf ai && mkdir -p ai
fi
exit 0
