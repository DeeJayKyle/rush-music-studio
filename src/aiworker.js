// ---------------------------------------------------------------------------
// AI stem separation worker (Rush neural engine, HTDemucs v4 weights by Meta, MIT).
// Roles:
//  • coordinator — talks to the page, splits songs into overlapping 7.8 s windows
//    (exactly as the reference implementation does), runs them on the GPU (WebGPU)
//    or on several CPU engine workers in parallel, cross-fades the results and
//    streams every finished stretch of audio back immediately, starting at the
//    playhead ("focus") so the deck can switch to AI stems right away.
//  • engine — a CPU worker that owns one WebAssembly instance of the network.
// ---------------------------------------------------------------------------
const SR = 44100;
let role = null;

// ============================== engine worker (CPU) ==============================
let net = null;
async function engineMessage(m) {
  if (m.type === 'einit') {
    try { net = await StemNet.create({ wasm: m.wasm, model: m.model, backend: 'cpu' }); self.postMessage({ type: 'eready' }); }
    catch (e) { self.postMessage({ type: 'efail', error: String(e && e.message || e) }); }
  } else if (m.type === 'seg') {
    try {
      const t0 = performance.now();
      const out = await net.segment(m.L, m.R);
      const data = []; for (const s of out) for (const c of s) data.push(c);
      self.postMessage({ type: 'out', key: m.key, data, ms: performance.now() - t0 }, data.map((d) => d.buffer));
    } catch (e) { self.postMessage({ type: 'eerr', key: m.key, error: String(e && e.message || e) }); }
  }
}

// ============================== coordinator ==============================
const C = { engines: [], ep: '', threads: 0, chunkMs: 0, jobs: new Map(), seq: 0, model: null, wasm: null, gpuInfo: '' };

function makeEngineWorker() {
  return new Promise((resolve) => {
    const w = new Worker(self.location.href);
    const eng = { w, busy: false, gpu: false, ms: 0, n: 0 };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'eready') resolve(eng);
      else if (m.type === 'efail') { w.terminate(); resolve(null); }
      else if (m.type === 'out') finishChunk(eng, m.key, m.data, m.ms);
      else if (m.type === 'eerr') failChunk(eng, m.key, m.error);
    };
    w.onerror = () => resolve(null);
    w.postMessage({ type: 'role', role: 'engine' });
    w.postMessage({ type: 'einit', wasm: C.wasm, model: C.model.slice(0) });
  });
}

async function init(m) {
  C.model = m.model; C.cores = m.cores;
  C.wasm = m.kernels.fma && WebAssembly.validate(new Uint8Array(m.kernels.fma)) ? m.kernels.fma : m.kernels.simd;
  const fma = C.wasm === m.kernels.fma;
  // 1) graphics card through WebGPU
  if (m.prefer !== 'cpu' && self.navigator && navigator.gpu) {
    try {
      const g = await StemNet.create({ model: C.model, backend: 'gpu' });
      const info = g.info || {};
      C.gpuInfo = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ');
      if (/swiftshader|llvmpipe|software/i.test(C.gpuInfo) && m.prefer !== 'gpu') throw new Error('software GPU (' + C.gpuInfo + ')');
      C.engines.push({ gpu: true, net: g, busy: false, ms: 0, n: 0 });
      C.ep = 'webgpu'; C.threads = 1;
      self.postMessage({ type: 'ready', ep: C.ep, threads: 1, chunkMs: 0, gpu: C.gpuInfo });
      return;
    } catch (e) { self.postMessage({ type: 'log', text: 'WebGPU unavailable: ' + (e && e.message || e) }); }
  }
  // 2) CPU: several engine workers, each with its own copy of the network (~0.4 GB each)
  const cores = Math.max(1, m.cores || 4), memGB = m.memGB || 8;
  let n = Math.max(1, Math.min(cores - 1, 8, Math.floor(memGB * 1024 * 0.45 / 420)));
  if (m.maxThreads) n = Math.min(n, m.maxThreads);
  const ws = await Promise.all(Array.from({ length: n }, makeEngineWorker));
  C.engines = ws.filter(Boolean);
  if (!C.engines.length) { self.postMessage({ type: 'failed', error: 'the CPU engine could not start' }); return; }
  C.ep = 'wasm'; C.threads = C.engines.length;
  self.postMessage({ type: 'ready', ep: 'wasm', threads: C.threads, chunkMs: 0, fma });
}

// window layout for one pass: TensorChunk.padded / center_trim semantics of the reference implementation
function planJob(job) {
  const { len, seg, stride, shifts } = job;
  const chunks = [];
  const deltas = shifts > 1 ? Array.from({ length: shifts }, (_, p) => Math.round(p * stride / shifts)) : [0];
  deltas.forEach((d, pass) => {
    const lo = -d;
    for (let start = lo; start < len; start += stride) {
      const clen = Math.min(seg, len - start);
      const left = (seg - clen) >> 1;
      chunks.push({ id: chunks.length, pass, start, clen, wstart: start - left, left, state: 0 });
    }
  });
  job.chunks = chunks;
  // cells of `cell` samples; a cell is final once every window touching it is done
  job.cell = Math.max(SR * 2, Math.min(stride, SR * 4));
  job.nCells = Math.ceil(len / job.cell);
  job.cellChunks = Array.from({ length: job.nCells }, () => []);
  for (const ch of chunks) {
    const a = Math.max(0, ch.start), b = Math.min(len, ch.start + ch.clen);
    for (let c = Math.floor(a / job.cell); c * job.cell < b && c < job.nCells; c++) job.cellChunks[c].push(ch.id);
  }
  job.cellLeft = job.cellChunks.map((l) => l.length);
  job.acc = new Map();   // cell -> { data: [8 x Float32Array], w: Float32Array }
}
function nextChunk() {
  let best = null, bestJob = null, bestScore = Infinity;
  for (const job of C.jobs.values()) {
    if (job.cancelled) continue;
    const f = job.focus;
    for (const ch of job.chunks) {
      if (ch.state !== 0) continue;
      // windows covering the focus point first, then forwards in time, then the start; earlier passes first
      const mid = ch.start + ch.clen / 2;
      let d = mid >= f - job.seg / 2 ? mid - f : 1e12 + mid;
      const score = -job.priority * 1e15 + ch.pass * 1e13 + d;
      if (score < bestScore) { bestScore = score; best = ch; bestJob = job; }
    }
  }
  return best ? { job: bestJob, ch: best } : null;
}
function pump() {
  for (const eng of C.engines) {
    if (eng.busy) continue;
    const nx = nextChunk(); if (!nx) return;
    const { job, ch } = nx;
    ch.state = 1; eng.busy = true; eng.cur = { job, ch };
    const seg = job.seg, L = new Float32Array(seg), R = new Float32Array(seg);
    for (let i = 0; i < seg; i++) { const t = ch.wstart + i; if (t >= 0 && t < job.len) { L[i] = job.L[t]; R[i] = job.R[t]; } }
    const key = job.id + ':' + ch.id;
    if (eng.gpu) {
      const t0 = performance.now();
      eng.net.segment(L, R).then((out) => { const data = []; for (const s of out) for (const c of s) data.push(c); finishChunk(eng, key, data, performance.now() - t0); })
        .catch((e) => failChunk(eng, key, String(e && e.message || e)));
    } else eng.w.postMessage({ type: 'seg', key, L, R }, [L.buffer, R.buffer]);
  }
}
function finishChunk(eng, key, data, ms) {
  eng.busy = false; eng.cur = null;
  eng.ms = eng.n ? eng.ms * 0.7 + ms * 0.3 : ms; eng.n++;
  C.chunkMs = eng.ms / (eng.gpu ? 1 : 1);
  const [jid, cid] = key.split(':').map(Number), job = C.jobs.get(jid);
  if (job && !job.cancelled) {
    const ch = job.chunks[cid]; ch.state = 2;
    accumulate(job, ch, data);
    job.finished++;
    self.postMessage({ type: 'progress', id: job.id, p: job.finished / job.chunks.length, chunkMs: C.chunkMs, engines: C.engines.length });
    if (job.finished === job.chunks.length) { self.postMessage({ type: 'done', id: job.id, ms: performance.now() - job.t0 }); C.jobs.delete(job.id); }
  }
  pump();
}
function failChunk(eng, key, error) {
  eng.busy = false; eng.cur = null;
  const [jid, cid] = key.split(':').map(Number), job = C.jobs.get(jid);
  if (eng.gpu && !C.fallingBack) {
    // the graphics card failed (driver reset, out of memory…): continue on the CPU engines
    C.fallingBack = true;
    self.postMessage({ type: 'log', text: 'GPU engine failed (' + error + '), switching to the CPU' });
    if (job) job.chunks[cid].state = 0;
    try { eng.net.destroy(); } catch (e) { }
    C.engines = [];
    (async () => {
      const n = Math.max(1, Math.min((C.cores || 4) - 1, 8));
      C.engines = (await Promise.all(Array.from({ length: n }, makeEngineWorker))).filter(Boolean);
      C.ep = 'wasm'; C.threads = C.engines.length;
      self.postMessage({ type: 'device', ep: 'wasm', threads: C.threads });
      if (!C.engines.length) for (const j of C.jobs.values()) { j.cancelled = true; self.postMessage({ type: 'error', id: j.id, error: 'no engine left' }); }
      pump();
    })();
    return;
  }
  if (job) { job.cancelled = true; C.jobs.delete(jid); self.postMessage({ type: 'error', id: jid, error }); }
  pump();
}
// triangular cross-fade weight of window position i (transition_power = 1)
function weight(seg, i) { const half = seg >> 1; return (i < half ? i + 1 : seg - i) / half; }
function accumulate(job, ch, data) {
  const { len, cell, seg } = job;
  const a = Math.max(0, ch.start), b = Math.min(len, ch.start + ch.clen);
  for (let c = Math.floor(a / cell); c * cell < b && c < job.nCells; c++) {
    const c0 = c * cell, c1 = Math.min(len, c0 + cell);
    let acc = job.acc.get(c);
    if (!acc) { acc = { data: Array.from({ length: 8 }, () => new Float32Array(c1 - c0)), w: new Float32Array(c1 - c0) }; job.acc.set(c, acc); }
    const s = Math.max(a, c0), e = Math.min(b, c1);
    for (let t = s; t < e; t++) {
      const i = t - ch.start;                 // position inside the trimmed window
      const wv = weight(seg, i), y = ch.left + i, k = t - c0;
      acc.w[k] += wv;
      for (let q = 0; q < 8; q++) acc.data[q][k] += wv * data[q][y];
    }
    if (--job.cellLeft[c] === 0) {
      // final: undo the track normalisation and stream it out
      const out = acc.data.map((d) => { const r = new Float32Array(d.length); for (let k = 0; k < d.length; k++) r[k] = (d[k] / (acc.w[k] || 1)) * job.std + job.mean; return r; });
      job.acc.delete(c);
      self.postMessage({ type: 'region', id: job.id, a: c0, b: c1, data: out }, out.map((d) => d.buffer));
    }
  }
}
function separate(m) {
  const L = m.L, R = m.R, len = L.length;
  // normalise by the whole track (mono reference), as the reference separator does
  let s = 0; for (let i = 0; i < len; i++) s += (L[i] + R[i]) * 0.5;
  const mean = s / Math.max(1, len); let v = 0; for (let i = 0; i < len; i++) { const d = (L[i] + R[i]) * 0.5 - mean; v += d * d; }
  const std = Math.sqrt(v / Math.max(1, len - 1)) || 1;
  const Ln = new Float32Array(len), Rn = new Float32Array(len);
  for (let i = 0; i < len; i++) { Ln[i] = (L[i] - mean) / std; Rn[i] = (R[i] - mean) / std; }
  const seg = StemNet.SEG, overlap = Math.min(0.75, Math.max(0, m.overlap ?? 0.25));
  const job = { id: m.id, L: Ln, R: Rn, len, seg, stride: Math.floor((1 - overlap) * seg), shifts: Math.max(1, m.shifts || 1), mean, std, focus: m.at || 0, priority: m.priority || 0, finished: 0, t0: performance.now() };
  planJob(job);
  C.jobs.set(job.id, job);
  pump();
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'role') { role = m.role; return; }
  if (role === 'engine') return engineMessage(m);
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'separate') separate(m);
    else if (m.type === 'focus') { const j = C.jobs.get(m.id); if (j) { j.focus = m.at; if (m.priority != null) j.priority = m.priority; } }
    else if (m.type === 'priority') { const j = C.jobs.get(m.id); if (j) j.priority = m.priority; }
    else if (m.type === 'cancel') { const j = C.jobs.get(m.id); if (j) { j.cancelled = true; C.jobs.delete(m.id); } }
  } catch (err) {
    if (m.type === 'init') self.postMessage({ type: 'failed', error: String(err && err.message || err) });
    else if (m.id != null) self.postMessage({ type: 'error', id: m.id, error: String(err && err.message || err) });
  }
};
