#!/usr/bin/env python3
"""CI check: Rush's neural engine must reproduce the NumPy reference of HTDemucs.
usage: stemnet_check.py model.rsm   (prints a GitHub notice; exits 1 on mismatch)"""
import numpy as np, subprocess, sys, os, json, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
model = sys.argv[1]
rng = np.random.default_rng(7)
n = 44100 * 3
t = np.arange(n) / 44100
kick = np.sin(2 * np.pi * 55 * t) * np.exp(-((t * 2) % 1) * 18)
hat = rng.standard_normal(n) * np.exp(-((t * 4) % 1) * 40) * 0.2
voice = 0.25 * np.sin(2 * np.pi * (220 + 30 * np.sin(2 * np.pi * 5 * t)) * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.5 * t))
x = np.stack([0.6 * kick + hat + voice, 0.6 * kick + 0.8 * hat + 0.9 * voice]).astype(np.float32)
d = tempfile.mkdtemp()
x.tofile(os.path.join(d, 'in.f32'))
subprocess.run([sys.executable, os.path.join(HERE, 'htdemucs_ref.py'), model, os.path.join(d, 'in.f32'), os.path.join(d, 'ref.f32')], check=True)
ref = np.fromfile(os.path.join(d, 'ref.f32'), np.float32).reshape(4, 2, n)
res = []
for variant in ('simd', 'fma'):
    r = subprocess.run(['node', os.path.join(HERE, 'stemnet_check.js'), model, os.path.join(d, 'in.f32'), os.path.join(d, 'out.f32'), variant], capture_output=True, text=True)
    if r.returncode:
        print(r.stdout, r.stderr); res.append((variant, None, None)); continue
    info = json.loads(r.stdout)
    if 'skipped' in info:
        print(variant, 'skipped:', info['skipped']); continue
    out = np.fromfile(os.path.join(d, 'out.f32'), np.float32).reshape(4, 2, n)
    sdr = [10 * np.log10((ref[s] ** 2).sum() / ((ref[s] - out[s]) ** 2).sum()) for s in range(4)]
    res.append((variant, min(sdr), info['ms']))
ok = bool(res) and all(v is not None and v > 50 for _, v, _ in res)
msg = ' | '.join(f'{k}: agreement {v:.1f} dB in {ms} ms' if v is not None else f'{k}: failed' for k, v, ms in res)
print(('::notice' if ok else '::error') + ' title=Neural engine vs reference::' + msg)
sys.exit(0 if ok else 1)
