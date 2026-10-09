#!/usr/bin/env bash
# Prepares the AI stem model for the desktop build:
#   official HTDemucs v4 checkpoint (MIT, Meta) -> Rush's fp16 model file (tools/htdemucs_to_rsm.py, NumPy only).
# The network itself runs in Rush's own engine (src/stemnet.js), so no third-party runtime is bundled.
# A failed download leaves the app on its fast built-in separator; it never breaks the build.
set -u
cd "$(dirname "$0")"
rm -rf ai && mkdir -p ai/models
CK=955717e8-8726e21a.th
ok=0
for url in "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/$CK" \
           "https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/$CK"; do
  if curl -fsSL --retry 4 --retry-delay 8 -o "$CK" "$url"; then ok=1; break; fi
done
[ $ok = 1 ] && { python -c 'import numpy' 2>/dev/null || python -m pip install -q numpy >/dev/null 2>&1; }
if [ $ok = 1 ] && python ../tools/htdemucs_to_rsm.py "$CK" ai/models/rush-htdemucs.rsm; then
  cat > ai/models/manifest.json <<JSON
{ "format": "rush-stemnet", "model": "rush-htdemucs.rsm", "name": "HTDemucs v4", "sampleRate": 44100, "segment": 343980, "stems": ["drums", "bass", "other", "vocals"] }
JSON
  cp ../THIRD_PARTY.md ai/ 2>/dev/null || true
  echo "::notice title=AI stems::Bundled HTDemucs v4 ($(du -h ai/models/rush-htdemucs.rsm | cut -f1)) for Rush's neural engine"
else
  echo "::warning title=AI stems::Could not prepare the HTDemucs model; the app falls back to the fast separator"
  rm -rf ai && mkdir -p ai
fi
rm -f "$CK"
exit 0
