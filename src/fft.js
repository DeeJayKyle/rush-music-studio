// ---------------------------------------------------------------------------
// Rush DSP core — radix-2 complex FFT with cached plans (shared by UI + workers)
// ---------------------------------------------------------------------------
const FFT = (() => {
  const cache = new Map();
  function plan(n) {
    let p = cache.get(n);
    if (p) return p;
    const levels = Math.round(Math.log2(n));
    if ((1 << levels) !== n) throw new Error('FFT size must be a power of two');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    p = { n, rev, cos, sin };
    cache.set(n, p);
    return p;
  }
  function transform(re, im, inverse) {
    const n = re.length, p = plan(n), rev = p.rev, C = p.cos, S = p.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = C[k], wi = sgn * S[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
  }
  const winCache = new Map();
  function hann(n) {
    let w = winCache.get(n);
    if (w) return w;
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    winCache.set(n, w);
    return w;
  }
  return { transform, hann, plan };
})();
