// ---------------------------------------------------------------------------
// Rush mastering stage (runs in a DSP worker):
//   • ITU-R BS.1770-4 / EBU R128 integrated loudness (LUFS) and true peak (dBTP)
//   • loudness normalisation to a target
//   • look-ahead true-peak brick-wall limiter (4× oversampled detection)
//   • TPDF dither with noise shaping for 16/24-bit output
//   • WAV writer with LIST/INFO metadata
// ---------------------------------------------------------------------------

// K-weighting biquads for any sample rate (same design as the BS.1770 reference filters)
function kWeighting(sr) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan(Math.PI * f0 / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  })();
  const hp = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan(Math.PI * f0 / sr);
    const a0 = 1 + K / Q + K * K;
    return { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  })();
  return [shelf, hp];
}
function biquadRun(x, c) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; const o = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
  return y;
}
// K-weighted energy per 100 ms hop (summed over channels)
function hopEnergy(chs, sr) {
  const [f1, f2] = kWeighting(sr), hop = Math.round(0.1 * sr), n = chs[0].length, H = Math.floor(n / hop);
  const E = new Float64Array(H);
  for (const x of chs) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    for (let j = 0, i = 0; j < H; j++) {
      let e = 0;
      for (const end = i + hop; i < end; i++) {
        const v = x[i];
        const a = f1.b0 * v + f1.b1 * x1 + f1.b2 * x2 - f1.a1 * y1 - f1.a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = a;
        const b = f2.b0 * a + f2.b1 * u1 + f2.b2 * u2 - f2.a1 * v1 - f2.a2 * v2; u2 = u1; u1 = a; v2 = v1; v1 = b;
        e += b * b;
      }
      E[j] += e;
    }
  }
  return { E, hop };
}
// integrated loudness (LUFS) from hop energies, optionally weighted by a per-hop gain² (fast what-if)
function loudnessFromHops(E, hop, g2) {
  const L = (p) => -0.691 + 10 * Math.log10(p + 1e-30);
  const z = [], blk = 4 * hop;
  for (let k = 0; k + 4 <= E.length; k++) {
    let s = 0; for (let q = k; q < k + 4; q++) s += g2 ? E[q] * g2[q] : E[q];
    z.push(s / blk);
  }
  if (!z.length) return { integrated: -Infinity, shortMax: -Infinity };
  let sa = 0, na = 0; for (const p of z) if (L(p) > -70) { sa += p; na++; }
  if (!na) return { integrated: -Infinity, shortMax: -Infinity };
  const rel = L(sa / na) - 10;
  let sg = 0, ng = 0; for (const p of z) if (L(p) > -70 && L(p) > rel) { sg += p; ng++; }
  let shortMax = -Infinity;
  for (let i = 0; i + 30 <= z.length; i += 5) { let s = 0; for (let q = i; q < i + 30; q++) s += z[q]; shortMax = Math.max(shortMax, L(s / 30)); }
  return { integrated: L(ng ? sg / ng : sa / na), shortMax };
}
// integrated loudness (LUFS) with absolute (−70) and relative (−10 LU) gating; also short-term max
function loudness(chs, sr) { const { E, hop } = hopEnergy(chs, sr); return loudnessFromHops(E, hop); }

// 4× oversampling interpolator (windowed sinc, 12 taps per phase as in ITU-R BS.1770-4 Annex 2)
const TP = (() => {
  const P = 4, T = 6, taps = [];
  for (let p = 0; p < P; p++) {
    const h = new Float64Array(2 * T); let s = 0;
    for (let k = 0; k < 2 * T; k++) {
      const t = k - T + 1 - p / P;                 // offset of tap from the interpolated point
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.42 + 0.5 * Math.cos(Math.PI * t / T) + 0.08 * Math.cos(2 * Math.PI * t / T); // Blackman
      h[k] = sinc * Math.max(0, w); s += h[k];
    }
    for (let k = 0; k < 2 * T; k++) h[k] /= s;
    taps.push(h);
  }
  return { P, T, taps };
})();
// per-sample true-peak magnitude across all channels. Inter-sample peaks only occur next to
// local maxima of |x|, so the oversampler runs only there (exact, and ~5-10× faster).
function truePeakEnv(chs) {
  const n = chs[0].length, out = new Float32Array(n), { P, T, taps } = TP, T2 = 2 * T;
  for (const x of chs) {
    for (let i = 0; i < n; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > out[i]) out[i] = a; }
    for (let i = 1; i < n - 1; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      if (a < 0.02) continue;
      const pa = x[i - 1] < 0 ? -x[i - 1] : x[i - 1], na = x[i + 1] < 0 ? -x[i + 1] : x[i + 1];
      if (a < pa || a < na) continue;               // not a local maximum
      // interpolate between (i-1, i) and (i, i+1)
      for (let base = i - 1; base <= i; base++) {
        let m = 0;
        for (let p = 1; p < P; p++) {
          const h = taps[p]; let acc = 0;
          const j0 = base - T + 1;
          if (j0 >= 0 && j0 + T2 <= n) for (let k = 0; k < T2; k++) acc += x[j0 + k] * h[k];
          else for (let k = 0; k < T2; k++) { const j = j0 + k; if (j >= 0 && j < n) acc += x[j] * h[k]; }
          if (acc < 0) acc = -acc; if (acc > m) m = acc;
        }
        if (m > out[base]) out[base] = m;
        if (m > out[base + 1]) out[base + 1] = m;
      }
    }
  }
  return out;
}
function truePeakDb(chs) { const e = truePeakEnv(chs); let m = 0; for (let i = 0; i < e.length; i++) if (e[i] > m) m = e[i]; return 20 * Math.log10(m + 1e-12); }

// look-ahead gain computer: req = per-sample gain needed; returns a smooth gain that is never late
function smoothGain(req, sr, releaseMs, lookMs) {
  const n = req.length, La = Math.max(1, Math.round(lookMs / 1000 * sr)), W = La + 1;
  // forward-looking minimum over [i, i+La] (van Herk / Gil-Werman: two linear passes)
  const pre = new Float32Array(n), suf = new Float32Array(n);
  for (let b0 = 0; b0 < n; b0 += W) {
    const b1 = Math.min(n, b0 + W);
    let m = 1; for (let i = b0; i < b1; i++) { const v = req[i]; if (v < m) m = v; pre[i] = m; }
    m = 1; for (let i = b1 - 1; i >= b0; i--) { const v = req[i]; if (v < m) m = v; suf[i] = m; }
  }
  const g = pre;   // reuse: g[i] = min(suf[i], pre[i+La]) computed in place from the left
  for (let i = 0; i < n; i++) { const j = i + La; const a = suf[i], b = j < n ? pre[j] : 1; suf[i] = a < b ? a : b; }
  // moving average over the look-ahead window gives a smooth attack that is never late
  let acc = 0; const inv = 1 / La;
  for (let i = 0; i < n; i++) { acc += suf[i]; if (i >= La) acc -= suf[i - La]; g[i] = i >= La - 1 ? acc * inv : acc / (i + 1); }
  const rel = 1 - Math.exp(-1 / (releaseMs / 1000 * sr));
  let cur = 1;
  for (let i = 0; i < n; i++) { const v = g[i]; cur = v < cur ? v : cur + (1 - cur) * rel; if (cur > v) cur = v; g[i] = cur; }
  return g;
}
// brick-wall true-peak limiter on real audio (used as the final safety stage)
function limit(chs, sr, ceilingDb, releaseMs = 120, lookMs = 2) {
  const n = chs[0].length, ceil = Math.pow(10, ceilingDb / 20);
  const tp = truePeakEnv(chs), req = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) { if (tp[i] > ceil) { req[i] = ceil / tp[i]; any = true; } else req[i] = 1; }
  if (!any) return { chs, reduction: 0 };
  const g = smoothGain(req, sr, releaseMs, lookMs);
  let mn = 1; for (let i = 0; i < n; i++) if (g[i] < mn) mn = g[i];
  const out = chs.map((x) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) { let v = x[i] * g[i]; if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil; y[i] = v; } return y; });
  return { chs: out, reduction: -20 * Math.log10(mn) };
}

// TPDF dither + first-order error-feedback noise shaping → integer PCM
function quantize(chs, bits, dither) {
  const q = Math.pow(2, bits - 1) - 1, n = chs[0].length, nch = chs.length;
  const out = bits === 16 ? new Int16Array(n * nch) : new Int32Array(n * nch);
  for (let c = 0; c < nch; c++) {
    const x = chs[c]; let e = 0;
    for (let i = 0; i < n; i++) {
      let v = x[i] * q;
      if (dither) { v += (Math.random() - Math.random()) - e * 0.5; }
      let r = Math.round(v); if (r > q) r = q; else if (r < -q - 1) r = -q - 1;
      if (dither) e = r - v;
      out[i * nch + c] = r;
    }
  }
  return out;
}
function infoChunk(meta) {
  const items = [['INAM', meta.title], ['IART', meta.artist], ['IENG', meta.engineer], ['ICOP', meta.copyright], ['ICMT', meta.comments], ['ISFT', 'Rush Music Studio']].filter(([, v]) => v);
  const enc = new TextEncoder(), parts = [];
  let size = 4;
  for (const [id, v] of items) { const b = enc.encode(v + '\0'); const pad = b.length % 2; parts.push([id, b, pad]); size += 8 + b.length + pad; }
  const buf = new Uint8Array(8 + size), dv = new DataView(buf.buffer); let o = 0;
  const ws = (s) => { for (let i = 0; i < 4; i++) buf[o++] = s.charCodeAt(i); };
  ws('LIST'); dv.setUint32(o, size, true); o += 4; ws('INFO');
  for (const [id, b, pad] of parts) { ws(id); dv.setUint32(o, b.length, true); o += 4; buf.set(b, o); o += b.length + pad; }
  return buf;
}
function wavFile(chs, sr, bits, dither, meta) {
  const nch = chs.length, n = chs[0].length, isFloat = bits === 32, bps = bits / 8;
  const info = meta ? infoChunk(meta) : new Uint8Array(0);
  const dataLen = n * nch * bps;
  const buf = new ArrayBuffer(44 + info.length + dataLen), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + info.length + dataLen, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, isFloat ? 3 : 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nch * bps, true); dv.setUint16(32, nch * bps, true); dv.setUint16(34, bits, true);
  u8.set(info, 36);
  let o = 36 + info.length;
  ws(o, 'data'); dv.setUint32(o + 4, dataLen, true); o += 8;
  if (isFloat) { for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { dv.setFloat32(o, chs[c][i], true); o += 4; } }
  else if (bits === 16) { const q = quantize(chs, 16, dither); new Int16Array(buf, o, n * nch).set(q); }
  else { const q = quantize(chs, 24, dither); for (let i = 0; i < q.length; i++) { const s = q[i]; u8[o] = s & 255; u8[o + 1] = (s >> 8) & 255; u8[o + 2] = (s >> 16) & 255; o += 3; } }
  return buf;
}

// full chain: measure → (normalise + two-stage limit, solved on envelopes) → apply once → verify
function masterProcess(m) {
  let chs = m.ch;
  const sr = m.sr, o = m.opts || {}, n = chs[0].length;
  const { E, hop } = hopEnergy(chs, sr);
  const before = loudnessFromHops(E, hop);
  const tp = truePeakEnv(chs);
  let tpMax = 0; for (let i = 0; i < n; i++) if (tp[i] > tpMax) tpMax = tp[i];
  const tpBefore = 20 * Math.log10(tpMax + 1e-12);
  const target = o.targetLufs != null && isFinite(before.integrated) ? o.targetLufs : null;
  let gainDb = target != null ? clampW(target - before.integrated, -30, 30) : 0;
  let G = null, reduction = 0;
  const H = E.length, g2 = new Float64Array(H);
  // total gain curve for a given input gain: gentle slow stage (+2.5 dB above the ceiling), then fast true-peak stage
  const curve = (gDb) => {
    const gin = Math.pow(10, gDb / 20);
    if (o.ceilingDb == null) return { G: null, gin };
    const c1 = Math.pow(10, (o.ceilingDb + 2.5) / 20), c2 = Math.pow(10, (o.ceilingDb - 0.05) / 20);
    const req = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) { const v = gin * tp[i]; if (v > c1) { req[i] = c1 / v; any = true; } else req[i] = 1; }
    const g1 = any ? smoothGain(req, sr, 280, 8) : null;
    any = false;
    for (let i = 0; i < n; i++) { const v = gin * (g1 ? g1[i] : 1) * tp[i]; if (v > c2) { req[i] = c2 / v; any = true; } else req[i] = 1; }
    const g = any ? smoothGain(req, sr, o.releaseMs || 120, 2) : null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = gin * (g1 ? g1[i] : 1) * (g ? g[i] : 1);
    return { G: out, gin };
  };
  const estimate = (c) => {
    if (!c.G) return before.integrated + 20 * Math.log10(c.gin);
    for (let j = 0; j < H; j++) { let s = 0; const a = j * hop; for (let i = a; i < a + hop; i++) s += c.G[i] * c.G[i]; g2[j] = s / hop; }
    return loudnessFromHops(E, hop, g2).integrated;
  };
  const src = chs;
  let bias = 0, after = null, capped = false;
  for (let round = 0; round < 3; round++) {
    let c = curve(gainDb);
    if (target != null && c.G) {
      const maxRed = o.maxReduction || 10;            // never limit deeper than this: it starts to sound crushed
      const red = (k) => { if (!k.G) return 0; let mn = Infinity; for (let i = 0; i < n; i += 4) { const r = k.G[i] / k.gin; if (r < mn) mn = r; } return -20 * Math.log10(mn); };
      for (let pass = 0; pass < 10; pass++) {          // limiting costs loudness: re-aim the input gain
        const miss = target - (estimate(c) + bias);
        if (Math.abs(miss) < 0.05 || gainDb >= 36) break;
        const prevDb = gainDb, prevC = c;
        gainDb = Math.min(36, gainDb + miss * 1.1);
        c = curve(gainDb);
        if (miss > 0 && red(c) > maxRed) {
          // find the loudest gain that stays within the limiting budget
          let lo = prevDb, hi = gainDb, best = prevC;
          for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2, cm = curve(mid); if (red(cm) > maxRed) hi = mid; else { lo = mid; best = cm; } }
          gainDb = lo; c = best; capped = true; break;
        }
      }
    }
    G = c.G; reduction = 0;
    if (G) { chs = src.map((x) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = x[i] * G[i]; return y; }); let mn = Infinity; for (let i = 0; i < n; i++) { const r = G[i] / c.gin; if (r < mn) mn = r; } reduction = -20 * Math.log10(mn); }
    else if (gainDb) { const gin = c.gin; chs = src.map((x) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = x[i] * gin; return y; }); }
    // safety: the envelope model is very close; an exact true-peak pass removes any residue
    if (o.ceilingDb != null) { const r = limit(chs, sr, o.ceilingDb - 0.05, 60, 1.5); chs = r.chs; reduction = Math.max(reduction, r.reduction); }
    after = loudness(chs, sr);
    // heavy limiting makes the fast estimate optimistic: correct it with the exact measurement and solve again
    if (capped || target == null || !G || !isFinite(after.integrated) || Math.abs(target - after.integrated) < 0.2 || gainDb >= 36) break;
    bias += after.integrated - (estimate(curve(gainDb)) + bias);
  }
  const tpAfter = truePeakDb(chs);
  const stats = { capped, lufsIn: before.integrated, tpIn: tpBefore, gainDb, reduction, lufsOut: after.integrated, tpOut: tpAfter, shortMax: after.shortMax };
  if (o.format === 'wav') return { wav: wavFile(chs, sr, o.bits || 24, o.dither !== false, o.meta), stats };
  return { chs, stats };
}
function clampW(v, a, b) { return v < a ? a : v > b ? b : v; }
