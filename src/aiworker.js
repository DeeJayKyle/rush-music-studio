// ---------------------------------------------------------------------------
// AI stem separation worker: Hybrid Transformer Demucs (HTDemucs v4, MIT,
// Meta AI) running in ONNX Runtime (WebGPU when available, else multi-threaded
// WebAssembly). Long songs are processed in overlapping 7.8 s windows that are
// cross-faded with triangular weights, exactly like the reference
// implementation. Windows are processed starting at the playhead, and every
// finished stretch of audio is sent back at once so the deck can switch to AI
// stems while the rest of the song is still being separated.
// ---------------------------------------------------------------------------

// Core: model-agnostic chunked separation. `run(input)` maps a [2*seg] float array
// (channel-major) to [nStems*2*seg]. Pure function of its inputs so it can be tested
// outside a worker.
async function separateCore({ L, R, seg, overlap = 0.25, nStems = 4, run, onRegion, onProgress, focus, cancelled }) {
  const len = L.length, stride = Math.max(1, Math.round(seg * (1 - overlap)));
  // normalise by the whole track's loudness (as Demucs does), undo it afterwards
  let mean = 0; for (let i = 0; i < len; i++) mean += (L[i] + R[i]) * 0.5; mean /= Math.max(1, len);
  let vr = 0; for (let i = 0; i < len; i++) { const d = (L[i] + R[i]) * 0.5 - mean; vr += d * d; }
  const std = Math.sqrt(vr / Math.max(1, len)) || 1;
  const nChunks = Math.max(1, Math.ceil(len / stride));
  // triangular cross-fade weights
  const w = new Float32Array(seg), half = seg >> 1;
  for (let i = 0; i < seg; i++) w[i] = (i < half ? i + 1 : seg - i) / half;
  const out = []; for (let s = 0; s < nStems * 2; s++) out.push(new Float32Array(len));
  const wsum = new Float32Array(len);
  const done = new Uint8Array(nChunks);
  const nCells = Math.ceil(len / stride), sent = new Uint8Array(nCells);
  const inp = new Float32Array(2 * seg);
  const chunksOfCell = (c) => { const a = c * stride, b = Math.min(len, a + stride), r = []; for (let j = Math.max(0, Math.floor((a - seg) / stride)); j < nChunks && j * stride < b; j++) if (j * stride + seg > a) r.push(j); return r; };
  const cellReady = (c) => chunksOfCell(c).every((j) => done[j]);
  let finished = 0;
  const nextChunk = () => {
    const f = clampI(Math.floor((focus() || 0) / stride) - 1, 0, nChunks - 1);
    for (let j = f; j < nChunks; j++) if (!done[j]) return j;
    for (let j = 0; j < f; j++) if (!done[j]) return j;
    return -1;
  };
  for (;;) {
    if (cancelled && cancelled()) throw new Error('cancelled');
    const j = nextChunk(); if (j < 0) break;
    const off = j * stride, n = Math.min(seg, len - off);
    inp.fill(0);
    for (let i = 0; i < n; i++) { inp[i] = (L[off + i] - mean) / std; inp[seg + i] = (R[off + i] - mean) / std; }
    const y = await run(inp);
    for (let s = 0; s < nStems * 2; s++) { const o = out[s], base = s * seg; for (let i = 0; i < n; i++) o[off + i] += y[base + i] * w[i]; }
    for (let i = 0; i < n; i++) wsum[off + i] += w[i];
    done[j] = 1; finished++;
    // send every stretch of audio that no remaining window can still change
    const c0 = Math.max(0, Math.floor((off - seg) / stride)), c1 = Math.min(nCells - 1, Math.floor((off + seg) / stride));
    let runStart = -1;
    const flush = (cA, cB) => {
      const a = cA * stride, b = Math.min(len, (cB + 1) * stride), data = [];
      for (let s = 0; s < nStems * 2; s++) { const r = new Float32Array(b - a), o = out[s]; for (let i = a; i < b; i++) r[i - a] = (o[i] / (wsum[i] || 1)) * std + mean / nStems; data.push(r); }
      onRegion && onRegion(a, b, data);
    };
    for (let c = c0; c <= c1 + 1; c++) {
      const ok = c <= c1 && !sent[c] && cellReady(c);
      if (ok) { sent[c] = 1; if (runStart < 0) runStart = c; }
      else if (runStart >= 0) { flush(runStart, c - 1); runStart = -1; }
    }
    onProgress && onProgress(finished / nChunks);
  }
  return { std, mean };
}
function clampI(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---- worker plumbing (skipped when this file is loaded for tests) ----
if (typeof self !== 'undefined' && typeof importScripts === 'function') {
  let session = null, cfg = null, ep = '', inName = 'mix', outName = 'stems';
  const jobs = new Map();
  async function create(base, model, eps, threads) {
    ort.env.wasm.wasmPaths = base + 'ort/';
    ort.env.wasm.numThreads = threads;
    ort.env.logLevel = 'error';
    return ort.InferenceSession.create(base + 'models/' + model, { executionProviders: eps, graphOptimizationLevel: 'all' });
  }
  async function init(m) {
    importScripts(m.base + 'ort/' + (m.runtime || 'ort.all.min.js'));
    cfg = m.manifest;
    const iso = self.crossOriginIsolated || (m.isolated && typeof SharedArrayBuffer !== 'undefined');
    const c = m.cores || 4, threads = iso ? Math.min(16, c <= 4 ? c : c - 1) : 1;
    const tries = [];
    if (m.prefer !== 'cpu' && self.navigator && navigator.gpu) {
      try { const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (ad) tries.push(['webgpu', 'wasm']); } catch (e) { }
    }
    tries.push(['wasm']);
    let lastErr = null;
    for (const eps of tries) {
      try {
        session = await create(m.base, cfg.model, eps, threads);
        inName = session.inputNames[0]; outName = session.outputNames[0];
        ep = eps[0];
        // sanity run: a GPU that returns garbage falls back to the CPU
        const t0 = performance.now();
        const y = await runChunk(new Float32Array(2 * cfg.segment).map((_, i) => Math.sin(i * 0.05) * 0.3));
        let bad = false; for (let i = 0; i < y.length; i += 997) if (!isFinite(y[i])) { bad = true; break; }
        if (bad) throw new Error('model produced invalid output on ' + ep);
        return { ep, threads, chunkMs: performance.now() - t0, iso: !!self.crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined' };
      } catch (e) { lastErr = e; session = null; }
    }
    throw lastErr || new Error('Could not start ONNX Runtime');
  }
  async function runChunk(x) {
    const t = new ort.Tensor('float32', x, [1, 2, cfg.segment]);
    const r = await session.run({ [inName]: t });
    const o = r[outName];
    const d = o.data instanceof Float32Array ? o.data : Float32Array.from(o.data);
    if (o.dispose) o.dispose();
    return d;
  }
  self.onmessage = async (ev) => {
    const m = ev.data;
    try {
      if (m.type === 'init') { const info = await init(m); self.postMessage({ type: 'ready', ...info }); return; }
      if (m.type === 'focus') { const j = jobs.get(m.id); if (j) j.focus = m.at; return; }
      if (m.type === 'cancel') { const j = jobs.get(m.id); if (j) j.cancel = true; return; }
      if (m.type === 'separate') {
        const job = { focus: m.at || 0, cancel: false }; jobs.set(m.id, job);
        const t0 = performance.now();
        await separateCore({
          L: m.L, R: m.R, seg: cfg.segment, overlap: m.overlap ?? 0.25, nStems: cfg.stems.length, run: runChunk,
          focus: () => job.focus, cancelled: () => job.cancel,
          onRegion: (a, b, data) => self.postMessage({ type: 'region', id: m.id, a, b, data }, data.map((d) => d.buffer)),
          onProgress: (p) => self.postMessage({ type: 'progress', id: m.id, p }),
        });
        jobs.delete(m.id);
        self.postMessage({ type: 'done', id: m.id, ms: performance.now() - t0 });
      }
    } catch (e) {
      if (m.id != null) jobs.delete(m.id);
      self.postMessage({ type: m.type === 'init' ? 'failed' : 'error', id: m.id, error: String(e && e.message || e) });
    }
  };
}
