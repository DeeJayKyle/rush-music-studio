#!/usr/bin/env python3
"""Convert the official HTDemucs v4 checkpoint (955717e8-8726e21a.th, MIT licence, Meta)
into Rush's stem model format (.rsm): "RSTM" magic, JSON index, fp16 tensors (64-byte aligned).

Needs only Python 3 and NumPy (no PyTorch): the checkpoint's pickle is read with a
restricted unpickler that only rebuilds tensors and plain containers.

usage: htdemucs_to_rsm.py 955717e8-8726e21a.th rush-htdemucs.rsm
"""
import collections, hashlib, json, pickle, struct, sys, zipfile
import numpy as np

EXPECTED_SHA256_PREFIX = '8726e21a'   # Demucs names checkpoints <signature>-<sha256[:8]>.th
SAFE = {('_codecs', 'encode'), ('builtins', 'set'), ('builtins', 'frozenset'), ('builtins', 'slice'), ('builtins', 'complex'), ('builtins', 'bytearray')}
DT = {'FloatStorage': np.float32, 'HalfStorage': np.float16, 'LongStorage': np.int64, 'IntStorage': np.int32, 'DoubleStorage': np.float64, 'BoolStorage': np.bool_}


def load_state(path):
    z = zipfile.ZipFile(path)
    prefix = z.namelist()[0].split('/')[0]

    def rebuild(storage, offset, size, stride, *rest):
        dt, key = storage
        raw = np.frombuffer(z.read(f'{prefix}/data/{key}'), dtype=dt)
        if not size:
            return raw[offset:offset + 1].reshape(())
        return np.array(np.lib.stride_tricks.as_strided(raw[offset:], shape=size, strides=[s * raw.itemsize for s in stride]))

    class Stub:
        def __init__(self, *a, **k): pass
        def __setstate__(self, s): pass

    class Unpickler(pickle.Unpickler):
        def find_class(self, mod, name):
            if name == '_rebuild_tensor_v2': return rebuild
            if name == '_rebuild_parameter': return lambda d, *a: d
            if name in DT: return name
            if mod == 'collections' and name == 'OrderedDict': return collections.OrderedDict
            if mod.split('.')[0] in ('torch', 'demucs', 'omegaconf', 'fractions', 'pathlib', 'numpy'):
                return type(name, (Stub,), {})
            if (mod, name) in SAFE: return super().find_class(mod, name)
            raise pickle.UnpicklingError(f'refusing to load {mod}.{name}')

        def persistent_load(self, pid):
            _, stype, key, loc, n = pid
            return (DT[stype], key)

    obj = Unpickler(z.open(f'{prefix}/data.pkl')).load()
    return obj['state']


def main(src, dst):
    sha = hashlib.sha256(open(src, 'rb').read()).hexdigest()
    if not sha.startswith(EXPECTED_SHA256_PREFIX):
        sys.exit(f'unexpected checkpoint (sha256 {sha[:16]}…); expected the official htdemucs 955717e8-8726e21a.th')
    state = load_state(src)
    idx, blobs, off = {}, [], 0
    for k, v in state.items():
        a = np.ascontiguousarray(np.asarray(v).astype(np.float16))
        pad = (-off) % 64
        if pad:
            blobs.append(b'\0' * pad); off += pad
        idx[k] = [off, list(a.shape)]
        b = a.tobytes(); blobs.append(b); off += len(b)
    meta = {'model': 'htdemucs', 'version': 1, 'sources': ['drums', 'bass', 'other', 'vocals'], 'samplerate': 44100, 'segment': 343980,
            'checkpoint_sha256': sha, 'licence': 'HTDemucs weights (c) Meta Platforms, Inc., MIT licence. https://github.com/facebookresearch/demucs',
            'tensors': idx}
    js = json.dumps(meta, separators=(',', ':')).encode()
    hl = 16 + len(js); hl += (-hl) % 64
    with open(dst, 'wb') as f:
        f.write(b'RSTM'); f.write(struct.pack('<III', 1, len(js), hl)); f.write(js); f.write(b'\0' * (hl - 16 - len(js)))
        for b in blobs: f.write(b)
    print(f'{dst}: {len(idx)} tensors, {(hl + off) / 1e6:.1f} MB')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
