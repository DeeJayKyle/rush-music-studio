#!/usr/bin/env python3
"""Independent NumPy reference of HTDemucs v4 inference, written from the PyTorch source
(facebookresearch/demucs: htdemucs.py, hdemucs.py, transformer.py, apply.py). CI uses it to check
that Rush's own engine (src/stemnet.js) computes the same network."""
import numpy as np, math, sys, json, struct

def load_rsm(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'RSTM'
    jl, hl = struct.unpack('<II', b[8:16])
    meta = json.loads(b[16:16 + jl])
    return {k: np.frombuffer(b, np.float16, int(np.prod(shape)) if shape else 1, hl + off).reshape(shape).astype(np.float32) for k, (off, shape) in meta['tensors'].items()}

W = {}
SR, NFFT, HOP = 44100, 4096, 1024
SEG = int(SR * 39 / 5)  # 343980

try:
    from scipy.special import erf as _erf
except ImportError:
    _erf = np.vectorize(math.erf)
def gelu(x):
    return (0.5 * x * (1 + _erf(x / math.sqrt(2)))).astype(np.float32)
def glu(x, axis=0):
    a, b = np.split(x, 2, axis=axis)
    return a * (1 / (1 + np.exp(-b)))

def conv1d(x, w, b, stride=1, pad=0, dil=1):
    # x (Cin, L), w (Cout, Cin, K)
    Cout, Cin, K = w.shape
    if pad: x = np.pad(x, ((0, 0), (pad, pad)))
    L = x.shape[1]; Lo = (L - dil * (K - 1) - 1) // stride + 1
    cols = np.stack([x[:, k * dil: k * dil + stride * (Lo - 1) + 1: stride] for k in range(K)], 1)  # Cin,K,Lo
    y = w.reshape(Cout, Cin * K) @ cols.reshape(Cin * K, Lo)
    return y + b[:, None]

def convF(x, w, b, stride, pad):
    # conv over freq axis only. x (Cin, F, T), w (Cout, Cin, K, 1)
    Cin, F, T = x.shape; Cout, _, K, _ = w.shape
    x = np.pad(x, ((0, 0), (pad, pad), (0, 0)))
    Fo = (F + 2 * pad - K) // stride + 1
    cols = np.stack([x[:, k: k + stride * (Fo - 1) + 1: stride, :] for k in range(K)], 1)  # Cin,K,Fo,T
    y = w.reshape(Cout, Cin * K) @ cols.reshape(Cin * K, Fo * T)
    return y.reshape(Cout, Fo, T) + b[:, None, None]

def conv2d33(x, w, b):
    Cin, F, T = x.shape; Cout = w.shape[0]
    xp = np.pad(x, ((0, 0), (1, 1), (1, 1)))
    cols = np.stack([xp[:, i:i + F, j:j + T] for i in range(3) for j in range(3)], 1)  # Cin,9,F,T
    y = w.reshape(Cout, Cin * 9) @ cols.reshape(Cin * 9, F * T)
    return y.reshape(Cout, F, T) + b[:, None, None]

def convtr1d(x, w, b, stride):
    # x (Cin, L), w (Cin, Cout, K)
    Cin, Cout, K = w.shape; L = x.shape[1]
    y = w.reshape(Cin, Cout * K).T @ x  # Cout*K, L
    y = y.reshape(Cout, K, L)
    out = np.zeros((Cout, (L - 1) * stride + K), np.float32)
    for k in range(K): out[:, k: k + stride * (L - 1) + 1: stride] += y[:, k]
    return out + b[:, None]

def convtrF(x, w, b, stride):
    # x (Cin, F, T), w (Cin, Cout, K, 1)
    Cin, F, T = x.shape; _, Cout, K, _ = w.shape
    y = (w.reshape(Cin, Cout * K).T @ x.reshape(Cin, F * T)).reshape(Cout, K, F, T)
    out = np.zeros((Cout, (F - 1) * stride + K, T), np.float32)
    for k in range(K): out[:, k: k + stride * (F - 1) + 1: stride] += y[:, k]
    return out + b[:, None, None]

def gn1(x, w, b, eps=1e-5):
    # GroupNorm(1) over whole tensor (C, ...) with per-channel affine
    m = x.mean(); v = x.var()
    y = (x - m) / np.sqrt(v + eps)
    sh = (-1,) + (1,) * (x.ndim - 1)
    return y * w.reshape(sh) + b.reshape(sh)

def dconv(x, p):
    # x (C, T)
    for d in range(2):
        q = f'{p}.dconv.layers.{d}'
        dil = 2 ** d
        y = conv1d(x, W[q + '.0.weight'], W[q + '.0.bias'], pad=dil, dil=dil)
        y = gelu(gn1(y, W[q + '.1.weight'], W[q + '.1.bias']))
        y = conv1d(y, W[q + '.3.weight'], W[q + '.3.bias'])
        y = glu(gn1(y, W[q + '.4.weight'], W[q + '.4.bias']))
        x = x + W[q + '.6.scale'][:, None] * y
    return x

def dconvF(x, p):
    # x (C, F, T): per frequency row
    return np.stack([dconv(x[:, f], p) for f in range(x.shape[1])], 1)

def enc_t(x, i):
    p = f'tencoder.{i}'
    if x.shape[1] % 4: x = np.pad(x, ((0, 0), (0, 4 - x.shape[1] % 4)))
    y = gelu(conv1d(x, W[p + '.conv.weight'], W[p + '.conv.bias'], stride=4, pad=2))
    y = dconv(y, p)
    return glu(conv1d(y, W[p + '.rewrite.weight'], W[p + '.rewrite.bias']))

def enc_f(x, i, inject=None):
    p = f'encoder.{i}'
    y = convF(x, W[p + '.conv.weight'], W[p + '.conv.bias'], 4, 2)
    y = gelu(y)
    y = dconvF(y, p)
    C, F, T = y.shape
    z = (W[p + '.rewrite.weight'].reshape(2 * C, C) @ y.reshape(C, F * T)).reshape(2 * C, F, T) + W[p + '.rewrite.bias'][:, None, None]
    return glu(z)

def dec_f(x, skip, i, last):
    p = f'decoder.{i}'
    x = x + skip
    y = glu(conv2d33(x, W[p + '.rewrite.weight'], W[p + '.rewrite.bias']))
    y = dconvF(y, p)
    z = convtrF(y, W[p + '.conv_tr.weight'], W[p + '.conv_tr.bias'], 4)[:, 2:-2]
    return z if last else gelu(z)

def dec_t(x, skip, i, length, last):
    p = f'tdecoder.{i}'
    x = x + skip
    y = glu(conv1d(x, W[p + '.rewrite.weight'], W[p + '.rewrite.bias'], pad=1))
    y = dconv(y, p)
    z = convtr1d(y, W[p + '.conv_tr.weight'], W[p + '.conv_tr.bias'], 4)[:, 2:2 + length]
    return z if last else gelu(z)

def layernorm(x, w, b, eps=1e-5):
    m = x.mean(-1, keepdims=True); v = x.var(-1, keepdims=True)
    return (x - m) / np.sqrt(v + eps) * w + b

def mha(q, k, p):
    # q (T, C), k (S, C)
    w = W[p + '.in_proj_weight']; bb = W[p + '.in_proj_bias']; C = q.shape[1]
    Q = q @ w[:C].T + bb[:C]; K = k @ w[C:2 * C].T + bb[C:2 * C]; V = k @ w[2 * C:].T + bb[2 * C:]
    H = 8; D = C // H; out = np.zeros_like(Q)
    for h in range(H):
        s = (Q[:, h * D:(h + 1) * D] / math.sqrt(D)) @ K[:, h * D:(h + 1) * D].T
        s = s - s.max(-1, keepdims=True); e = np.exp(s); e /= e.sum(-1, keepdims=True)
        out[:, h * D:(h + 1) * D] = e @ V[:, h * D:(h + 1) * D]
    return out @ W[p + '.out_proj.weight'].T + W[p + '.out_proj.bias']

def ff(x, p):
    return gelu(x @ W[p + '.linear1.weight'].T + W[p + '.linear1.bias']) @ W[p + '.linear2.weight'].T + W[p + '.linear2.bias']

def gn_tc(x, w, b, eps=1e-5):
    m = x.mean(); v = x.var()
    return (x - m) / np.sqrt(v + eps) * w + b

def tlayer(x, p):
    x = x + W[p + '.gamma_1.scale'] * mha(layernorm(x, W[p + '.norm1.weight'], W[p + '.norm1.bias']), layernorm(x, W[p + '.norm1.weight'], W[p + '.norm1.bias']), p + '.self_attn')
    x = x + W[p + '.gamma_2.scale'] * ff(layernorm(x, W[p + '.norm2.weight'], W[p + '.norm2.bias']), p)
    return gn_tc(x, W[p + '.norm_out.weight'], W[p + '.norm_out.bias'])

def xlayer(q, k, p):
    x = q + W[p + '.gamma_1.scale'] * mha(layernorm(q, W[p + '.norm1.weight'], W[p + '.norm1.bias']), layernorm(k, W[p + '.norm2.weight'], W[p + '.norm2.bias']), p + '.cross_attn')
    x = x + W[p + '.gamma_2.scale'] * ff(layernorm(x, W[p + '.norm3.weight'], W[p + '.norm3.bias']), p)
    return gn_tc(x, W[p + '.norm_out.weight'], W[p + '.norm_out.bias'])

def pos2d(C, Fr, T1):
    pe = np.zeros((C, Fr, T1), np.float32); d = C // 2
    div = np.exp(np.arange(0., d, 2) * -(math.log(10000.) / d))
    pw = np.arange(T1)[:, None] * div; ph = np.arange(Fr)[:, None] * div
    pe[0:d:2] = np.sin(pw).T[:, None, :]; pe[1:d:2] = np.cos(pw).T[:, None, :]
    pe[d::2] = np.sin(ph).T[:, :, None]; pe[d + 1::2] = np.cos(ph).T[:, :, None]
    return pe

def pos1d(T, C):
    pos = np.arange(T)[:, None]; half = C // 2; ad = np.arange(half)[None]
    ph = pos / (10000. ** (ad / (half - 1)))
    return np.concatenate([np.cos(ph), np.sin(ph)], -1).astype(np.float32)

def transformer(x, xt):
    C, Fr, T1 = x.shape
    xs = x.transpose(2, 1, 0).reshape(T1 * Fr, C)  # (t1 fr) c
    xs = layernorm(xs, W['crosstransformer.norm_in.weight'], W['crosstransformer.norm_in.bias'])
    xs = xs + pos2d(C, Fr, T1).transpose(2, 1, 0).reshape(T1 * Fr, C)
    ts = xt.T
    ts = layernorm(ts, W['crosstransformer.norm_in_t.weight'], W['crosstransformer.norm_in_t.bias']) + pos1d(ts.shape[0], C)
    for i in range(5):
        p, pt = f'crosstransformer.layers.{i}', f'crosstransformer.layers_t.{i}'
        if i % 2 == 0: xs, ts = tlayer(xs, p), tlayer(ts, pt)
        else:
            old = xs; xs = xlayer(xs, ts, p); ts = xlayer(ts, old, pt)
    return xs.reshape(T1, Fr, C).transpose(2, 1, 0), ts.T

def hann(n): return (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float64)

def stft(x):  # x (L,), torch-like center reflect, normalized
    w = hann(NFFT); xp = np.pad(x, (NFFT // 2, NFFT // 2), mode='reflect')
    n = 1 + (len(xp) - NFFT) // HOP
    fr = np.stack([xp[i * HOP: i * HOP + NFFT] * w for i in range(n)], 1)
    return np.fft.rfft(fr, axis=0) / math.sqrt(NFFT)  # (2049, n)

def istft(z, length):  # z (2049, n)
    w = hann(NFFT); n = z.shape[1]
    fr = np.fft.irfft(z * math.sqrt(NFFT), n=NFFT, axis=0) * w[:, None]
    L = NFFT + HOP * (n - 1); y = np.zeros(L); env = np.zeros(L)
    for i in range(n): y[i * HOP:i * HOP + NFFT] += fr[:, i]; env[i * HOP:i * HOP + NFFT] += w * w
    y = y[NFFT // 2:]; env = env[NFFT // 2:]
    y = y[:length]; env = env[:length]
    return (y / np.where(env > 1e-11, env, 1)).astype(np.float32)

def model(mix):  # mix (2, SEG)
    L = mix.shape[1]
    le = math.ceil(L / HOP); pad = HOP // 2 * 3
    xpad = np.pad(mix, ((0, 0), (pad, pad + le * HOP - L)), mode='reflect')
    z = np.stack([stft(xpad[c].astype(np.float64)) for c in range(2)])[:, :-1, 2:2 + le]  # (2, 2048, le)
    mag = np.stack([z[0].real, z[0].imag, z[1].real, z[1].imag]).astype(np.float32)
    mean, std = mag.mean(), mag.std(ddof=1)
    x = (mag - mean) / (1e-5 + std)
    meant, stdt = mix.mean(), mix.std(ddof=1)
    xt = (mix - meant) / (1e-5 + stdt)
    saved, saved_t, lens_t = [], [], []
    for i in range(4):
        lens_t.append(xt.shape[1]); xt = enc_t(xt, i); saved_t.append(xt)
        x = enc_f(x, i)
        if i == 0: x = x + 0.2 * 10 * W['freq_emb.embedding.weight'].T[:, :, None]
        saved.append(x)
    C, Fr, T1 = x.shape
    x = (W['channel_upsampler.weight'][:, :, 0] @ x.reshape(C, Fr * T1) + W['channel_upsampler.bias'][:, None]).reshape(-1, Fr, T1)
    xt = W['channel_upsampler_t.weight'][:, :, 0] @ xt + W['channel_upsampler_t.bias'][:, None]
    x, xt = transformer(x, xt)
    x = (W['channel_downsampler.weight'][:, :, 0] @ x.reshape(512, Fr * T1) + W['channel_downsampler.bias'][:, None]).reshape(C, Fr, T1)
    xt = W['channel_downsampler_t.weight'][:, :, 0] @ xt + W['channel_downsampler_t.bias'][:, None]
    for i in range(4):
        x = dec_f(x, saved.pop(), i, i == 3)
        xt = dec_t(xt, saved_t.pop(), i, lens_t.pop(), i == 3)
    x = x.reshape(4, 4, 2048, le) * std + mean
    out = np.zeros((4, 2, L), np.float32)
    for s in range(4):
        for c in range(2):
            zz = np.zeros((2049, le + 4), np.complex128)
            zz[:2048, 2:2 + le] = x[s, 2 * c] + 1j * x[s, 2 * c + 1]
            lo = HOP * le + 2 * pad
            out[s, c] = istft(zz, lo)[pad:pad + L]
    xt = xt.reshape(4, 2, L) * stdt + meant
    return out + xt

def separate(mix):  # mix (2, N) -> (4, 2, N)
    ref = mix.mean(0); m, sd = ref.mean(), ref.std(ddof=1)
    mixn = (mix - m) / sd
    N = mix.shape[1]; stride = int(0.75 * SEG)
    wgt = np.concatenate([np.arange(1, SEG // 2 + 1), np.arange(SEG - SEG // 2, 0, -1)]).astype(np.float32); wgt /= wgt.max()
    out = np.zeros((4, 2, N), np.float32); sw = np.zeros(N, np.float32)
    for off in range(0, N, stride):
        clen = min(SEG, N - off)
        delta = SEG - clen; start = off - delta // 2; end = start + SEG
        cs, ce = max(0, start), min(N, end)
        chunk = np.pad(mixn[:, cs:ce], ((0, 0), (cs - start, end - ce)))
        y = model(chunk)
        d2 = (SEG - clen) // 2; y = y[..., d2:d2 + clen]
        out[..., off:off + clen] += wgt[:clen] * y; sw[off:off + clen] += wgt[:clen]
        print('segment', off, flush=True)
    return out / sw * sd + m

if __name__ == '__main__':
    # usage: htdemucs_ref.py model.rsm input.f32 (2 x N planar) output.f32 (4 x 2 x N)
    W.update(load_rsm(sys.argv[1]))
    x = np.fromfile(sys.argv[2], np.float32).reshape(2, -1)
    model(x).astype(np.float32).tofile(sys.argv[3])
