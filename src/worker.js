// ---------------------------------------------------------------------------
// Rush DSP worker — runs in a pool, one per CPU core.
// Tasks: separate (4-stem), analyze (BPM + key), stretch (WSOLA), pitch,
//        denoise (spectral), spectrogram
// (FFT is prepended to this source at build time.)
// ---------------------------------------------------------------------------

function slideMedian(src, off, stride, n, w, dst) {
  const h = w >> 1, win = new Float64Array(w);
  const get = (i) => src[off + (i < 0 ? 0 : i >= n ? n - 1 : i) * stride];
  for (let j = 0; j < w; j++) win[j] = get(j - h);
  win.sort();
  for (let i = 0; i < n; i++) {
    dst[off + i * stride] = win[h];
    const out = get(i - h), inn = get(i + h + 1);
    if (out === inn) continue;
    let lo = 0, hi = w - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < out) lo = m + 1; else hi = m; }
    let p = lo;
    if (inn > out) { while (p < w - 1 && win[p + 1] < inn) { win[p] = win[p + 1]; p++; } win[p] = inn; }
    else { while (p > 0 && win[p - 1] > inn) { win[p] = win[p - 1]; p--; } win[p] = inn; }
  }
}

function rcos(x) { return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x))); }

// ---- 4-stem separation: HPSS + stereo-centre + spectral band masks -------
function separate(L, R, sr, opts) {
  const N = 4096, H = 1024, B = N / 2 + 1, len = L.length;
  const frames = Math.ceil((len + N / 2) / H) + 1;
  const win = FFT.hann(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const LR = new Float32Array(frames * B), LI = new Float32Array(frames * B);
  const RR = new Float32Array(frames * B), RI = new Float32Array(frames * B);
  const MAG = new Float32Array(frames * B), CEN = new Float32Array(frames * B);
  let sideE = 0, midE = 0;

  for (let f = 0; f < frames; f++) {
    const s = f * H - N / 2;
    for (let n = 0; n < N; n++) {
      const idx = s + n;
      if (idx >= 0 && idx < len) { re[n] = L[idx] * win[n]; im[n] = R[idx] * win[n]; }
      else { re[n] = 0; im[n] = 0; }
    }
    FFT.transform(re, im, false);
    const o = f * B;
    for (let k = 0; k < B; k++) {
      const nk = (N - k) % N;
      const lr = (re[k] + re[nk]) * 0.5, li = (im[k] - im[nk]) * 0.5;
      const rr = (im[k] + im[nk]) * 0.5, ri = -(re[k] - re[nk]) * 0.5;
      LR[o + k] = lr; LI[o + k] = li; RR[o + k] = rr; RI[o + k] = ri;
      const ml = Math.sqrt((lr)*(lr)+(li)*(li)), mr = Math.sqrt((rr)*(rr)+(ri)*(ri));
      MAG[o + k] = Math.sqrt(ml * ml + mr * mr);
      const dr = lr - rr, di = li - ri, d = Math.sqrt((dr)*(dr)+(di)*(di));
      CEN[o + k] = 1 - Math.min(1, d / (ml + mr + 1e-9));
      const sr2 = lr + rr, si2 = li + ri;
      midE += sr2 * sr2 + si2 * si2; sideE += dr * dr + di * di;
    }
  }
  const stereoWidth = sideE / (midE + 1e-9);
  const monoish = stereoWidth < 0.02;

  // Harmonic (median across time) & percussive (median across frequency)
  const HM = new Float32Array(frames * B), PM = new Float32Array(frames * B);
  const Wt = 17, Wf = 17;
  for (let k = 0; k < B; k++) slideMedian(MAG, k, B, frames, Wt, HM);
  for (let f = 0; f < frames; f++) slideMedian(MAG, f * B, 1, B, Wf, PM);

  // Frequency weights
  const bassW = new Float32Array(B), vBand = new Float32Array(B);
  for (let k = 0; k < B; k++) {
    const hz = k * sr / N;
    bassW[k] = 1 - rcos((hz - 90) / 170);            // 1 below 90 Hz → 0 above 260 Hz
    vBand[k] = rcos((hz - 110) / 160) * (1 - rcos((hz - 7000) / 4500));
  }
  const vocBoost = opts && opts.vocalFocus != null ? opts.vocalFocus : 1;

  const out = {
    vocals: [new Float32Array(len), new Float32Array(len)],
    drums: [new Float32Array(len), new Float32Array(len)],
    bass: [new Float32Array(len), new Float32Array(len)],
    other: [new Float32Array(len), new Float32Array(len)],
  };
  const norm = new Float32Array(len);
  const names = ['vocals', 'drums', 'bass', 'other'];
  const masks = names.map(() => new Float32Array(B));

  for (let f = 0; f < frames; f++) {
    const o = f * B;
    const op = f > 0 ? o - B : o, on = f < frames - 1 ? o + B : o;
    for (let k = 0; k < B; k++) {
      const h = HM[o + k], p = PM[o + k];
      const h2 = h * h, p2 = p * p;
      const hm = h2 / (h2 + p2 + 1e-18);
      const pm = 1 - hm;
      let c = (CEN[op + k] + 2 * CEN[o + k] + CEN[on + k]) * 0.25;
      c = monoish ? 0.55 : c * c * c;
      const bw = bassW[k];
      let v = hm * (1 - bw) * vBand[k] * Math.min(1, c * vocBoost);
      const b = hm * bw;
      const ot = hm * (1 - bw) - v;
      // a small share of centred, mid-band transient energy belongs to the voice (consonants)
      const cons = pm * vBand[k] * (monoish ? 0.1 : c * 0.35) * (1 - bw);
      masks[0][k] = v + cons;
      masks[1][k] = pm - cons;
      masks[2][k] = b;
      masks[3][k] = ot > 0 ? ot : 0;
    }
    const s = f * H - N / 2;
    for (let st = 0; st < 3; st++) {
      const m = masks[st];
      // pack L + iR spectrum then inverse FFT once per stem
      for (let k = 0; k < B; k++) {
        const g = m[k];
        const lr = LR[o + k] * g, li = LI[o + k] * g, rr = RR[o + k] * g, ri = RI[o + k] * g;
        re[k] = lr - ri; im[k] = li + rr;
        if (k > 0 && k < N / 2) { re[N - k] = lr + ri; im[N - k] = -li + rr; }
      }
      FFT.transform(re, im, true);
      const dl = out[names[st]][0], dr = out[names[st]][1];
      for (let n = 0; n < N; n++) {
        const idx = s + n;
        if (idx < 0 || idx >= len) continue;
        const w = win[n];
        dl[idx] += re[n] * w; dr[idx] += im[n] * w;
      }
    }
    for (let n = 0; n < N; n++) { const idx = s + n; if (idx >= 0 && idx < len) norm[idx] += win[n] * win[n]; }
  }
  // 'other' is the exact residual (masks sum to 1 and the STFT is linear)
  const v0 = out.vocals[0], v1 = out.vocals[1], d0 = out.drums[0], d1 = out.drums[1], b0 = out.bass[0], b1 = out.bass[1], o0 = out.other[0], o1 = out.other[1];
  for (let i = 0; i < len; i++) {
    const g = 1 / Math.max(norm[i], 1e-3);
    v0[i] *= g; v1[i] *= g; d0[i] *= g; d1[i] *= g; b0[i] *= g; b1[i] *= g;
    o0[i] = L[i] - v0[i] - d0[i] - b0[i];
    o1[i] = R[i] - v1[i] - d1[i] - b1[i];
  }
  return { stems: out, stereoWidth };
}

// ---- Tempo + key analysis -------------------------------------------------
function decimate(ch, sr) {
  let mono = ch[0];
  if (ch.length > 1) { mono = new Float32Array(ch[0].length); for (let i = 0; i < mono.length; i++) mono[i] = (ch[0][i] + ch[1][i]) * 0.5; }
  if (sr < 32000) return { x: mono, sr };
  const n = mono.length >> 1, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (mono[2 * i] + mono[2 * i + 1]) * 0.5;
  return { x, sr: sr / 2 };
}

const ONSET_LAG = 0.028;   // onset detector fires ~one window early
function analyze(ch, sr) {
  const d = decimate(ch, sr);
  const x = d.x, fs = d.sr, dur = ch[0].length / sr;
  // segment: at most 100 s from the middle
  const maxN = Math.floor(100 * fs);
  let a = 0, b = x.length;
  if (b > maxN) { a = Math.floor((b - maxN) / 2); b = a + maxN; }
  // onset envelope
  const N = 1024, H = 256, B = N / 2 + 1, win = FFT.hann(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const frames = Math.max(1, Math.floor((b - a - N) / H));
  // SuperFlux-style onset strength: log magnitude, compared with the max of
  // neighbouring bins two frames earlier (suppresses vibrato / pitch glides)
  const env = new Float64Array(frames), envLow = new Float64Array(frames);
  const lowBin = Math.max(2, Math.round(180 * N / fs)), prevLow = new Float64Array(64);
  const hist = [new Float64Array(B), new Float64Array(B)];
  const cur = new Float64Array(B);
  for (let f = 0; f < frames; f++) {
    const s = a + f * H;
    for (let n = 0; n < N; n++) { re[n] = x[s + n] * win[n]; im[n] = 0; }
    FFT.transform(re, im, false);
    let lowLin = 0;
    for (let k = 0; k < B; k++) { const mg = Math.sqrt(re[k] * re[k] + im[k] * im[k]); cur[k] = Math.log1p(100 * mg); if (k >= 1 && k <= lowBin) { const d = mg - prevLow[k]; if (d > 0) lowLin += d; prevLow[k] = mg; } }
    const ref = hist[f % 2];
    let flux = 0;
    if (f >= 2) for (let k = 1; k < B; k++) {
      let mx = ref[k]; for (let j = Math.max(0, k - 3); j <= Math.min(B - 1, k + 3); j++) if (ref[j] > mx) mx = ref[j];
      const dd = cur[k] - mx; if (dd > 0) flux += dd;
    }
    env[f] = flux; envLow[f] = lowLin;
    hist[f % 2].set(cur);
  }
  const fps = fs / H;
  // remove local mean
  const W = Math.round(fps * 0.5), e2 = new Float64Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i]; if (i >= W) acc -= env[i - W];
    e2[i] = Math.max(0, env[i] - acc / Math.min(i + 1, W));
  }
  const maxLag = Math.min(frames - 1, Math.ceil(fps * 16));
  const acf = new Float64Array(maxLag + 2);
  for (let l = 1; l <= maxLag; l++) { let s = 0; for (let i = l; i < frames; i++) s += e2[i] * e2[i - l]; acf[l] = s / (frames - l); }
  const at = (lag) => { const i = Math.floor(lag), fr = lag - i; if (i + 1 > maxLag) return 0; return acf[i] * (1 - fr) + acf[i + 1] * fr; };
  let best = 120, bestS = -1;
  for (let bpm = 60; bpm <= 200; bpm += 0.05) {
    const lag = fps * 60 / bpm;
    let s = 0, cnt = 0;
    for (let m = 1; m <= 8 && m * lag < maxLag; m++) { s += at(m * lag); cnt++; }
    s = s / Math.max(1, cnt) + 0.25 * at(lag / 2);
    const oct = Math.log2(bpm / 118);
    s *= Math.exp(-0.5 * (oct / 0.9) ** 2);
    if (s > bestS) { bestS = s; best = bpm; }
  }
  // refine with a long comb (up to 16 beats) for sub-0.1 BPM precision
  {
    let rb = best, rs = -Infinity;
    for (let bpm = best * 0.97; bpm <= best * 1.03; bpm += 0.01) {
      const lag = fps * 60 / bpm;
      let s = 0, cnt = 0;
      for (let m = 1; m <= 16 && m * lag < maxLag; m++) { s += at(m * lag); cnt++; }
      if (cnt && s / cnt > rs) { rs = s / cnt; rb = bpm; }
    }
    best = rb;
  }
  while (best < 70) best *= 2;
  while (best > 180) best /= 2;
  // Beat phase: where the first beat falls (so songs can be lined up on the bar grid)
  let firstBeat = 0;
  {
    const lagF = fps * 60 / best;
    // kick-weighted onset curve (low band), local mean removed
    const lo = new Float64Array(frames); let acc2 = 0;
    for (let i = 0; i < frames; i++) { acc2 += envLow[i]; if (i >= W) acc2 -= envLow[i - W]; lo[i] = Math.max(0, envLow[i] - acc2 / Math.min(i + 1, W)); }
    const atE = (f) => { const i = Math.floor(f), fr = f - i; if (i < 0 || i + 1 >= frames) return 0; return lo[i] * (1 - fr) + lo[i + 1] * fr; };
    let bp = 0, bs = -1;
    for (let p = 0; p < lagF; p += 0.25) { let sc = 0; for (let f = p; f < frames; f += lagF) sc += atE(f); if (sc > bs) { bs = sc; bp = p; } }
    const period = 60 / best;
    const t = (a + bp * H) / fs + ONSET_LAG;
    firstBeat = ((t % period) + period) % period;
  }
  // Loop detection: an exact number of beats in the file
  let isLoop = false, beats = dur * best / 60;
  if (dur < 32) {
    let cand = null, err = 1e9;
    for (const nb of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
      const bb = nb * 60 / dur;
      if (bb < 65 || bb > 190) continue;
      for (const mult of [1, 2, 0.5]) {
        const e = Math.abs(Math.log(bb / (best * mult)));
        if (e < err) { err = e; cand = { bpm: bb, nb }; }
      }
    }
    if (cand && err < 0.015) { best = cand.bpm; beats = cand.nb; isLoop = true; while (best < 70) { best *= 2; beats *= 2; } while (best > 180) { best /= 2; beats /= 2; } }
  }
  if (!isLoop) best = Math.round(best * 10) / 10;

  // key via chroma + Krumhansl profiles
  const NK = 8192, HK = 4096, BK = NK / 2 + 1, wk = FFT.hann(NK);
  const reK = new Float64Array(NK), imK = new Float64Array(NK);
  const chroma = new Float64Array(12);
  const pcOf = new Int16Array(BK).fill(-1);
  for (let k = 1; k < BK; k++) {
    const hz = k * fs / NK;
    if (hz < 55 || hz > 2000) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    pcOf[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const fk = Math.max(0, Math.floor((b - a - NK) / HK));
  for (let f = 0; f < fk; f++) {
    const s = a + f * HK;
    for (let n = 0; n < NK; n++) { reK[n] = x[s + n] * wk[n]; imK[n] = 0; }
    FFT.transform(reK, imK, false);
    for (let k = 1; k < BK; k++) { const pc = pcOf[k]; if (pc >= 0) chroma[pc] += Math.sqrt((reK[k])*(reK[k])+(imK[k])*(imK[k])); }
  }
  const maj = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const min = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (prof, rot) => {
    let mx = 0, my = 0; for (let i = 0; i < 12; i++) { mx += chroma[(i + rot) % 12]; my += prof[i]; } mx /= 12; my /= 12;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < 12; i++) { const dx = chroma[(i + rot) % 12] - mx, dy = prof[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxy / Math.sqrt(sxx * syy + 1e-18);
  };
  let key = null;
  if (fk > 0) {
    let bk = -2, bt = 0, bm = true;
    for (let r = 0; r < 12; r++) {
      const c1 = corr(maj, r), c2 = corr(min, r);
      if (c1 > bk) { bk = c1; bt = r; bm = true; }
      if (c2 > bk) { bk = c2; bt = r; bm = false; }
    }
    const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    const camMaj = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1], camMin = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
    key = { name: names[bt] + (bm ? ' major' : ' minor'), short: names[bt] + (bm ? '' : 'm'), camelot: (bm ? camMaj[bt] + 'B' : camMin[bt] + 'A'), confidence: bk };
  }
  if (isLoop) firstBeat = 0;
  return { bpm: best, beats, isLoop, key, firstBeat };
}

// ---- WSOLA time-stretch (pitch preserved) ---------------------------------
// pad both ends (circularly for loops) so the first and last frames aren't faded, then trim
function wsolaPadded(chs, ratio, sr, circular) {
  const n = chs[0].length, Pd = Math.min(sr >= 88000 ? 4096 : 2048, n);
  const padded = chs.map((x) => {
    const y = new Float32Array(n + 2 * Pd);
    if (circular) { y.set(x.subarray(n - Pd), 0); y.set(x.subarray(0, Pd), n + Pd); }
    y.set(x, Pd);
    return y;
  });
  const out = wsola(padded, ratio, sr);
  const s0 = Math.round(Pd * ratio), len = Math.max(1, Math.round(n * ratio));
  return out.map((d) => d.slice(s0, s0 + len));
}
function wsola(chs, ratio, sr) {
  // WSOLA with 75 % overlap (every transient lands in several frames, so none are dropped),
  // a tight search window (timing stays within a few ms of the grid) and a mild bias
  // towards the nominal position so drum hits stay on the beat.
  const big = sr >= 88000;
  const N = big ? 4096 : 2048, Hs = N >> 2, n = chs[0].length;
  const outLen = Math.max(1, Math.round(n * ratio));
  const Ha = Hs / ratio, S = big ? 256 : 128;
  const win = FFT.hann(N);
  let mono = chs[0];
  if (chs.length > 1) { mono = new Float32Array(n); for (let i = 0; i < n; i++) mono[i] = (chs[0][i] + chs[1][i]) * 0.5; }
  const out = chs.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const at = (i) => (i >= 0 && i < n ? mono[i] : 0);
  const L = N >> 1;                       // correlate over the first half of the frame
  let prevIn = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      const target = prevIn + Hs;          // where the previous frame naturally continues
      const score = (cand, stride) => {
        let dot = 0, e1 = 1e-9, e2 = 1e-9;
        for (let i = 0; i < L; i += stride) { const v = at(cand + i), w = at(target + i); dot += v * w; e1 += v * v; e2 += w * w; }
        return dot / Math.sqrt(e1 * e2) - 1.2 * Math.abs(cand - nominal) / S;
      };
      let bs = -Infinity;
      for (let c = nominal - S; c <= nominal + S; c += 4) { const sc = score(c, 4); if (sc > bs) { bs = sc; best = c; } }
      const c0 = best; bs = -Infinity;
      for (let c = c0 - 4; c <= c0 + 4; c++) { const sc = score(c, 1); if (sc > bs) { bs = sc; best = c; } }
    }
    const o = k * Hs;
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c], dst = out[c];
      for (let i = 0; i < N; i++) { const idx = best + i; if (idx >= 0 && idx < n) dst[o + i] += src[idx] * win[i]; }
    }
    for (let i = 0; i < N; i++) norm[o + i] += win[i];
    prevIn = best;
  }
  return out.map((d) => { const r = new Float32Array(outLen); for (let i = 0; i < outLen; i++) r[i] = d[i] / Math.max(norm[i], 0.15); return r; });
}

function resample(chs, outLen) {
  return chs.map((src) => {
    const n = src.length, dst = new Float32Array(outLen), r = (n - 1) / Math.max(1, outLen - 1);
    for (let i = 0; i < outLen; i++) {
      const p = i * r, j = Math.floor(p), f = p - j;
      const y0 = src[j > 0 ? j - 1 : 0], y1 = src[j], y2 = src[j + 1 < n ? j + 1 : n - 1], y3 = src[j + 2 < n ? j + 2 : n - 1];
      // Catmull-Rom cubic
      dst[i] = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
    }
    return dst;
  });
}

function stretchPitch(chs, ratio, semis, sr, loop) {
  if (!semis) return wsolaPadded(chs, ratio, sr, loop);
  const f = Math.pow(2, semis / 12);
  return resample(wsolaPadded(chs, ratio * f, sr, loop), Math.max(1, Math.round(chs[0].length * ratio)));
}
function pitchShift(chs, semis, sr) {
  const f = Math.pow(2, semis / 12);
  const st = wsolaPadded(chs, f, sr, false);
  return resample(st, chs[0].length);
}

// ---- Spectral noise reduction --------------------------------------------
function denoise(chs, noise, sr, reductionDb, sensitivity) {
  const N = 2048, H = 512, B = N / 2 + 1, win = FFT.hann(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  // noise profile from sample
  const prof = new Float64Array(B);
  let pf = 0;
  for (const nc of noise) {
    for (let s = 0; s + N <= nc.length; s += H) {
      for (let n = 0; n < N; n++) { re[n] = nc[s + n] * win[n]; im[n] = 0; }
      FFT.transform(re, im, false);
      for (let k = 0; k < B; k++) prof[k] += Math.sqrt((re[k])*(re[k])+(im[k])*(im[k]));
      pf++;
    }
  }
  if (pf === 0) throw new Error('Noise sample is too short. Select at least 50 ms of noise.');
  for (let k = 0; k < B; k++) prof[k] /= pf;
  const floor = Math.pow(10, -reductionDb / 20);
  const k2 = sensitivity * sensitivity;
  return chs.map((x) => {
    const len = x.length, y = new Float32Array(len), norm = new Float32Array(len);
    const g = new Float64Array(B), gPrev = new Float64Array(B).fill(1), gs = new Float64Array(B);
    for (let s = -N / 2; s < len; s += H) {
      for (let n = 0; n < N; n++) { const i = s + n; re[n] = (i >= 0 && i < len ? x[i] : 0) * win[n]; im[n] = 0; }
      FFT.transform(re, im, false);
      for (let k = 0; k < B; k++) {
        const m = Math.sqrt((re[k])*(re[k])+(im[k])*(im[k])) + 1e-12;
        const r = prof[k] / m;
        g[k] = Math.max(floor, 1 - k2 * r * r);
      }
      for (let k = 0; k < B; k++) {
        const sm = (g[k > 0 ? k - 1 : 0] + 2 * g[k] + g[k < B - 1 ? k + 1 : k]) * 0.25;
        gs[k] = sm > gPrev[k] ? sm : 0.55 * sm + 0.45 * gPrev[k];
        gPrev[k] = gs[k];
      }
      for (let k = 0; k < B; k++) {
        re[k] *= gs[k]; im[k] *= gs[k];
        if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      }
      FFT.transform(re, im, true);
      for (let n = 0; n < N; n++) { const i = s + n; if (i >= 0 && i < len) { y[i] += re[n] * win[n]; norm[i] += win[n] * win[n]; } }
    }
    for (let i = 0; i < len; i++) y[i] /= Math.max(norm[i], 1e-3);
    return y;
  });
}

// ---- Spectrogram (log-frequency, 8-bit) -----------------------------------
function spectrogram(chs, sr, cols, rows) {
  const N = 2048, B = N / 2 + 1, win = FFT.hann(N);
  const x = chs.length > 1 ? (() => { const m = new Float32Array(chs[0].length); for (let i = 0; i < m.length; i++) m[i] = (chs[0][i] + chs[1][i]) * 0.5; return m; })() : chs[0];
  const len = x.length;
  cols = Math.max(1, Math.min(cols, Math.floor(len / 64)));
  const out = new Uint8Array(cols * rows);
  const re = new Float64Array(N), im = new Float64Array(N);
  const fmin = 30, fmax = Math.min(20000, sr / 2);
  const rowBin = new Float32Array(rows + 1);
  for (let r = 0; r <= rows; r++) rowBin[r] = fmin * Math.pow(fmax / fmin, r / rows) * N / sr;
  for (let c = 0; c < cols; c++) {
    const center = Math.floor((c + 0.5) * len / cols), s = center - N / 2;
    for (let n = 0; n < N; n++) { const i = s + n; re[n] = (i >= 0 && i < len ? x[i] : 0) * win[n]; im[n] = 0; }
    FFT.transform(re, im, false);
    for (let r = 0; r < rows; r++) {
      const k0 = Math.floor(rowBin[r]), k1 = Math.max(k0 + 1, Math.floor(rowBin[r + 1]));
      let m = 0;
      for (let k = k0; k < k1 && k < B; k++) { const v = re[k] * re[k] + im[k] * im[k]; if (v > m) m = v; }
      const db = 10 * Math.log10(m / (N * N / 16) + 1e-12);
      const v = Math.max(0, Math.min(255, Math.round((db + 100) * 255 / 100)));
      out[(rows - 1 - r) * cols + c] = v;
    }
  }
  return { data: out, cols, rows };
}

self.onmessage = (ev) => {
  const m = ev.data, id = m.id;
  try {
    let result, transfer = [];
    if (m.type === 'separate') {
      const r = separate(m.L, m.R, m.sr, m.opts);
      result = r;
      for (const k in r.stems) transfer.push(r.stems[k][0].buffer, r.stems[k][1].buffer);
    } else if (m.type === 'analyze') {
      result = analyze(m.ch, m.sr);
    } else if (m.type === 'stretch') {
      result = wsolaPadded(m.ch, m.ratio, m.sr, false); transfer = result.map((a) => a.buffer);
    } else if (m.type === 'sp') {
      result = stretchPitch(m.ch, m.ratio, m.semis, m.sr, m.loop); transfer = result.map((a) => a.buffer);
    } else if (m.type === 'pitch') {
      result = pitchShift(m.ch, m.semis, m.sr); transfer = result.map((a) => a.buffer);
    } else if (m.type === 'denoise') {
      result = denoise(m.ch, m.noise, m.sr, m.reduction, m.sensitivity); transfer = result.map((a) => a.buffer);
    } else if (m.type === 'spectrogram') {
      result = spectrogram(m.ch, m.sr, m.cols, m.rows); transfer = [result.data.buffer];
    } else if (m.type === 'master') {
      result = masterProcess(m); transfer = result.wav ? [result.wav] : result.chs.map((a) => a.buffer);
    } else if (m.type === 'measure') {
      result = { ...loudness(m.ch, m.sr), tp: truePeakDb(m.ch) };
    } else throw new Error('Unknown task ' + m.type);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
