// ---------------------------------------------------------------------------
// Project model, assets, history, audio engine
// ---------------------------------------------------------------------------
const TRACK_COLORS = ['#ffb13b', '#5ec2ff', '#ff6b8a', '#46d39a', '#b77dff', '#ff8f4a', '#4fd6d6', '#e6d84a', '#8fa8ff', '#ff6bd5'];
const STEMS = [
  { key: 'vocals', label: 'Vocals', color: 'stVocals' },
  { key: 'melody', label: 'Melody', color: 'stMelody' },
  { key: 'bass', label: 'Bass', color: 'stBass' },
  { key: 'drums', label: 'Drums', color: 'stDrums' },
];

function newProject() {
  return {
    name: 'Untitled project', bpm: 105, bpb: 4, tracks: [],
    loop: { on: false, start: 0, end: 16 }, metro: false, snap: 1, cursor: 0,
    master: { vol: 0, limiter: true, low: 0, mid: 0, high: 0, rev: 2.2, dlyFb: 0.35, fx: [] },
    markers: [], meta: {}, sr: 0,
  };
}
function newTrack(name) {
  const i = P.tracks.length;
  return { id: uid('t'), name: name || 'Track ' + (i + 1), color: TRACK_COLORS[i % TRACK_COLORS.length], vol: 0, pan: 0, mute: false, solo: false, arm: false, low: 0, mid: 0, high: 0, comp: 0, rev: 0, dly: 0, clips: [], fx: [], env: { vol: [], pan: [], show: null }, pitch: 0 };
}

let P = newProject();
const S = { assets: new Map(), view: 'arrange', selClip: null, selTrack: null, dirty: false, editAsset: null, lastSaved: null };
const bus = { h: {}, on(e, f) { (this.h[e] = this.h[e] || []).push(f); }, emit(e, a) { (this.h[e] || []).forEach((f) => { try { f(a); } catch (err) { console.error(err); } }); } };

const spb = () => 60 / P.bpm;   // base tempo only; use T.* for positions
function projectEndBeats() {
  let e = 0;
  for (const t of P.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.len);
  return e;
}

// ---- history ------------------------------------------------------------------
const Hist = {
  undo: [], redo: [],
  push() { this.undo.push(JSON.stringify(P)); if (this.undo.length > 150) this.undo.shift(); this.redo = []; markDirty(); },
  apply(from, to) {
    if (!from.length) return false;
    to.push(JSON.stringify(P));
    const prev = P.bpm;
    P = JSON.parse(from.pop());
    migrateProject();
    if (prev !== P.bpm) $('#bpmInput').value = P.bpm;
    S.selClip = null;
    Engine.syncTracks(); Engine.refresh();
    bus.emit('project'); markDirty();
    return true;
  },
  doUndo() { if (this.apply(this.undo, this.redo)) status('Undo'); },
  doRedo() { if (this.apply(this.redo, this.undo)) status('Redo'); },
};
function markDirty() { S.dirty = true; const s = $('#statusSave'); if (s) s.textContent = 'Unsaved changes'; Autosave.schedule(); }

// ---- assets -------------------------------------------------------------------
function addAsset(name, buffer, meta = {}) {
  const A = {
    id: meta.id || uid('a'), name, buffer, peaks: computePeaks(buffer),
    bpm: meta.bpm || null, beats: meta.beats || null, isLoop: !!meta.isLoop, key: meta.key || null, generated: !!meta.generated, downbeat: meta.downbeat || 0,
    stretch: new Map(), stems: { state: 'none', buffers: null, peaks: null, promise: null, ms: 0 },
    version: 1, analyzing: false, undo: [], redo: [],
  };
  S.assets.set(A.id, A);
  if (!A.bpm) analyzeAsset(A);
  bus.emit('assets');
  return A;
}
async function analyzeAsset(A) {
  A.analyzing = true; bus.emit('assets');
  try {
    const ch = bufferChannels(A.buffer).map((c) => c.slice());
    const r = await Pool.run('analyze', { ch, sr: A.buffer.sampleRate }, ch.map((c) => c.buffer));
    A.bpm = r.bpm; A.beats = r.beats; A.isLoop = r.isLoop; A.key = r.key; A.downbeat = r.isLoop ? 0 : (r.firstBeat || 0);
  } catch (e) { console.warn(e); }
  A.analyzing = false; bus.emit('assets'); bus.emit('assetMeta', A);
}
function assetChanged(A, newBuffer) {
  if (newBuffer) A.buffer = newBuffer;
  A.peaks = computePeaks(A.buffer);
  A.stretch.clear();
  if (A.stems.state !== 'none') A.stems = { state: 'none', buffers: null, peaks: null, promise: null, ms: 0 };
  A.version++;
  bus.emit('assets'); bus.emit('assetChanged', A);
  Engine.refresh();
  markDirty();
}
function removeAsset(A) {
  Hist.push();
  for (const t of P.tracks) t.clips = t.clips.filter((c) => c.asset !== A.id);
  S.assets.delete(A.id);
  if (S.editAsset === A.id) S.editAsset = null;
  Engine.refresh(); bus.emit('assets'); bus.emit('project');
}

async function decodeFile(file) {
  const ctx = Engine.ensure(false);
  const ab = await file.arrayBuffer();
  return await ctx.decodeAudioData(ab);
}
async function importFiles(files, placeAt) {
  const out = [];
  for (const f of files) {
    if (/\.rush$/i.test(f.name)) { await Project.load(f); continue; }
    status('Importing ' + f.name + '…');
    try {
      const buf = await decodeFile(f);
      const A = addAsset(f.name.replace(/\.[^.]+$/, ''), buf);
      out.push(A);
      toast('Imported ' + f.name + ' · ' + fmtShort(buf.duration), 'ok');
    } catch (e) {
      toast(f.name + ' could not be decoded. Try WAV, MP3, FLAC, OGG or M4A.', 'err');
    }
  }
  status('Ready');
  return out;
}

// ---- tempo-synced buffers ------------------------------------------------------
function stemBuffer(A, stem) { return stem ? (A.stems.buffers && A.stems.buffers[stem]) : A.buffer; }
const trackOfClip = (clip) => P.tracks.find((t) => t.clips.includes(clip));
const isSynced = (clip, A) => !!(clip.sync && A && A.bpm);
const assetBeats = (A, base) => base.duration * A.bpm / 60;
// source beats are counted from the song's first downbeat; beats before it (an intro pickup) are negative
const srcBeatRange = (A, base) => { const db = A.downbeat || 0; return [-db * A.bpm / 60, (base.duration - db) * A.bpm / 60]; };
const clipSemis = (c, tr) => ((tr && tr.pitch) || 0) + (c.pitch || 0);
const fmod = (x, m) => ((x % m) + m) % m;
// stretched copy of an asset (or stem) at `R` BPM and `semis` transposition; null while it is being made
const stretchKey = (stem, R, semis) => (stem || 'mix') + '@' + (R == null ? 'free' : R.toFixed(2)) + '#' + semis;
const neededKeys = new Set();   // versions the arrangement uses right now: never evicted
let planning = false;
function getStretch(A, stem, R, semis = 0) {
  const base = stemBuffer(A, stem); if (!base) return null;
  const free = R == null;
  if ((free || Math.abs(A.bpm / R - 1) < 0.0005) && !semis) return base;
  const key = stretchKey(stem, R, semis);
  if (planning) neededKeys.add(A.id + '|' + key);
  const c = A.stretch.get(key);
  if (c && c !== 'pending') { A.stretch.delete(key); A.stretch.set(key, c); return c; } // LRU touch
  if (!c) requestStretch(A, stem, key, free ? 1 : A.bpm / R, semis);
  return null;
}
const stretchJobs = new Set();
function requestStretch(A, stem, key, ratio, semis = 0) {
  A.stretch.set(key, 'pending');
  const base = stemBuffer(A, stem);
  const ch = bufferChannels(base).map((c) => c.slice());
  const ver = A.version;
  const job = Pool.run('sp', { ch, ratio, semis, sr: base.sampleRate, loop: !!A.isLoop }, ch.map((c) => c.buffer)).then((res) => {
    if (A.version !== ver) return;
    A.stretch.set(key, makeBuffer(res, base.sampleRate));
    // keep the cache small (least recently used first)
    let n = 0; for (const v of A.stretch.values()) if (v !== 'pending') n++;
    if (n > 6) for (const [k, v] of A.stretch) { if (k !== key && v !== 'pending' && !neededKeys.has(A.id + '|' + k)) { A.stretch.delete(k); if (--n <= 6) break; } }
    Engine.refreshSoon();
    bus.emit('redraw');
  }).catch((e) => { A.stretch.delete(key); console.warn(e); }).finally(() => stretchJobs.delete(job));
  stretchJobs.add(job);
}
// request every stretched version the arrangement needs (for export)
function planStretches() {
  neededKeys.clear(); planning = true;
  try { planStretchesInner(); } finally { planning = false; }
}
function planStretchesInner() {
  for (const tr of P.tracks) for (const c of tr.clips) {
    const A = S.assets.get(c.asset); if (!A) continue;
    const semis = clipSemis(c, tr);
    if (!isSynced(c, A)) { if (semis) getStretch(A, c.stem, null, semis); continue; }
    if (c.keylock === false) { if (semis) getStretch(A, c.stem, A.bpm, semis); continue; }
    for (const p of T.pieces(c.start, c.start + c.len)) getStretch(A, c.stem, p.ramp ? Math.round(p.bpm) : Math.round(p.bpm * 100) / 100, semis);
  }
}
async function ensureStretched() {
  for (let round = 0; round < 4; round++) {
    planStretches();
    if (!stretchJobs.size) return;
    while (stretchJobs.size) await Promise.all([...stretchJobs]);
  }
}
// ---- clip geometry helpers (shared by the arranger) ----
function clipBase(c) { const A = S.assets.get(c.asset); return A ? stemBuffer(A, c.stem) : null; }
// seconds into the source file at timeline beat `beat` (null = past the end)
function clipBufTime(c, beat) {
  const A = S.assets.get(c.asset), base = clipBase(c); if (!A || !base) return null;
  if (isSynced(c, A)) {
    const period = assetBeats(A, base), [lo, hi] = srcBeatRange(A, base);
    let sb = (c.offB || 0) + (beat - c.start);
    if (c.loop) sb = fmod(sb - lo, period) + lo; else if (sb < lo || sb >= hi) return null;
    return (A.downbeat || 0) + sb * 60 / A.bpm;
  }
  let t = (c.offset || 0) + T.b2s(beat) - T.b2s(c.start);
  if (c.loop) t = fmod(t, base.duration); else if (t < 0 || t >= base.duration) return null;
  return t;
}
function clipMaxLen(c) {
  if (c.loop) return Infinity;
  const A = S.assets.get(c.asset), base = clipBase(c); if (!A || !base) return Infinity;
  if (isSynced(c, A)) return srcBeatRange(A, base)[1] - (c.offB || 0);
  return T.lenFor(c.start, base.duration - (c.offset || 0));
}
// move a clip's left edge to `ns` keeping its audio in place
function clipTrimStart(c, ns) {
  const A = S.assets.get(c.asset);
  if (isSynced(c, A)) c.offB = (c.offB || 0) + (ns - c.start);
  else c.offset = (c.offset || 0) + T.b2s(ns) - T.b2s(c.start);
  c.len = c.start + c.len - ns; c.start = ns;
}
function setBpm(nb) {
  nb = clamp(Math.round(nb * 1000) / 1000, 20, 300);
  if (!isFinite(nb)) return;
  const L = T.list();
  const at = Engine.playing ? Engine.posBeats() : P.cursor;
  const i = T.indexAt(at), m = L[i];
  if (Math.abs((i === 0 ? P.bpm : m.bpm) - nb) < 1e-9) return;
  Hist.push();
  if (L.length === 1) {
    // single tempo: un-synced clips keep their real length
    const ob = P.bpm;
    for (const t of P.tracks) for (const c of t.clips) { const A = S.assets.get(c.asset); if (!isSynced(c, A)) c.len *= nb / ob; }
  }
  if (i === 0) P.bpm = nb; else m.bpm = nb;
  $('#bpmInput').value = +nb.toFixed(2);
  Engine.refresh();
  bus.emit('project'); bus.emit('tempo');
}
function migrateProject() {
  T.list();
  P.markers = P.markers || [];
  P.mix = Object.assign({ overlap: 16, xfade: true, follow: false }, P.mix || {});
  for (const t of P.tracks) {
    t.fx = t.fx || []; t.env = Object.assign({ vol: [], pan: [], show: null }, t.env || {}); t.pitch = t.pitch || 0;
    for (const c of t.clips) {
      c.fx = c.fx || [];
      if (c.sync && c.offB == null) c.offB = (c.offset || 0) * P.bpm / 60;
      if (c.offB == null) c.offB = 0;
      if (c.offset == null) c.offset = 0;
    }
  }
}

// ---- stem separation -------------------------------------------------------------
async function separateAsset(A, onProgress) {
  if (A.stems.state === 'done') return A.stems;
  if (A.stems.promise) { A.stems.onProgress = onProgress; return A.stems.promise; }
  const t0 = performance.now();
  A.stems.state = 'running'; A.stems.onProgress = onProgress; A.stems.progress = 0;
  bus.emit('assets');
  const ver = A.version, buf = A.buffer, sr = buf.sampleRate, len = buf.length;
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const H = 1024, chunk = Math.ceil(sr * 10 / H) * H, pad = 16 * H;
  const out = { vocals: [new Float32Array(len), new Float32Array(len)], drums: [new Float32Array(len), new Float32Array(len)], bass: [new Float32Array(len), new Float32Array(len)], other: [new Float32Array(len), new Float32Array(len)] };
  const jobs = [];
  let done = 0;
  const total = Math.ceil(len / chunk);
  for (let s = 0; s < len; s += chunk) {
    const e = Math.min(len, s + chunk), a = Math.max(0, s - pad), b = Math.min(len, e + pad);
    const l = L.slice(a, b), r = R.slice(a, b);
    jobs.push(Pool.run('separate', { L: l, R: r, sr }, [l.buffer, r.buffer]).then((res) => {
      for (const k in out) {
        out[k][0].set(res.stems[k][0].subarray(s - a, s - a + (e - s)), s);
        out[k][1].set(res.stems[k][1].subarray(s - a, s - a + (e - s)), s);
      }
      done++;
      A.stems.progress = done / total;
      A.stems.onProgress && A.stems.onProgress(done / total);
    }));
  }
  A.stems.promise = Promise.all(jobs).then(() => {
    if (A.version !== ver) throw new Error('File changed during separation');
    const bufs = {
      vocals: makeBuffer(out.vocals, sr), melody: makeBuffer(out.other, sr),
      bass: makeBuffer(out.bass, sr), drums: makeBuffer(out.drums, sr),
    };
    A.stems.buffers = bufs;
    A.stems.peaks = {}; for (const k in bufs) A.stems.peaks[k] = computePeaks(bufs[k]);
    A.stems.state = 'done'; A.stems.ms = performance.now() - t0; A.stems.promise = null;
    bus.emit('assets'); bus.emit('stemsDone', A);
    return A.stems;
  }).catch((e) => { A.stems.state = 'none'; A.stems.promise = null; bus.emit('assets'); throw e; });
  return A.stems.promise;
}

// ---- audio graph -------------------------------------------------------------------
function makeImpulse(ctx, seconds, decay = 3) {
  const sr = ctx.sampleRate, n = Math.max(1, Math.floor(sr * seconds)), b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      lp = lp * 0.55 + (Math.random() * 2 - 1) * 0.45;   // darker tail
      d[i] = lp * Math.pow(1 - t, decay) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
    }
  }
  return b;
}
function buildMaster(ctx, dest) {
  const m = {};
  m.input = ctx.createGain();
  m.low = ctx.createBiquadFilter(); m.low.type = 'lowshelf'; m.low.frequency.value = 110;
  m.mid = ctx.createBiquadFilter(); m.mid.type = 'peaking'; m.mid.frequency.value = 1200; m.mid.Q.value = 0.8;
  m.high = ctx.createBiquadFilter(); m.high.type = 'highshelf'; m.high.frequency.value = 8000;
  m.gain = ctx.createGain();
  m.limiter = ctx.createDynamicsCompressor();
  m.out = ctx.createGain();
  m.chain = new Plugins.Chain(ctx);
  m.input.connect(m.chain.input); m.chain.output.connect(m.low); m.low.connect(m.mid).connect(m.high).connect(m.gain).connect(m.limiter).connect(m.out).connect(dest);
  m.split = ctx.createChannelSplitter(2);
  m.anL = ctx.createAnalyser(); m.anR = ctx.createAnalyser(); m.anL.fftSize = m.anR.fftSize = 2048;
  m.spec = ctx.createAnalyser(); m.spec.fftSize = 8192; m.spec.smoothingTimeConstant = 0.75;
  m.out.connect(m.split); m.split.connect(m.anL, 0); m.split.connect(m.anR, 1); m.out.connect(m.spec);
  // reverb bus
  m.revIn = ctx.createGain();
  m.conv = ctx.createConvolver(); m.conv.buffer = makeImpulse(ctx, P.master.rev || 2.2);
  m.revIn.connect(m.conv).connect(m.input);
  // tempo-synced ping-pong delay bus (dotted eighth)
  m.dlyIn = ctx.createGain();
  m.dL = ctx.createDelay(4); m.dR = ctx.createDelay(4);
  m.fb = ctx.createGain(); m.dlp = ctx.createBiquadFilter(); m.dlp.type = 'lowpass'; m.dlp.frequency.value = 4500;
  const merge = ctx.createChannelMerger(2);
  m.dlyIn.connect(m.dL); m.dL.connect(m.dR); m.dR.connect(m.dlp).connect(m.fb).connect(m.dL);
  m.dL.connect(merge, 0, 0); m.dR.connect(merge, 0, 1); merge.connect(m.input);
  applyMaster(m, ctx);
  return m;
}
function applyMaster(m, ctx) {
  const t = ctx.currentTime, M = P.master;
  m.low.gain.setTargetAtTime(M.low, t, 0.01); m.mid.gain.setTargetAtTime(M.mid, t, 0.01); m.high.gain.setTargetAtTime(M.high, t, 0.01);
  m.gain.gain.setTargetAtTime(dbToGain(M.vol), t, 0.01);
  if (M.limiter) { m.limiter.threshold.value = -1.5; m.limiter.knee.value = 0; m.limiter.ratio.value = 20; m.limiter.attack.value = 0.002; m.limiter.release.value = 0.12; }
  else { m.limiter.threshold.value = 0; m.limiter.ratio.value = 1; }
  const d = 60 / T.bpmAt(P.cursor) * 0.75;
  m.dL.delayTime.setTargetAtTime(d, t, 0.02); m.dR.delayTime.setTargetAtTime(d, t, 0.02);
  m.fb.gain.setTargetAtTime(M.dlyFb, t, 0.02);
  m.chain.set(M.fx || []);
}
function buildTrack(ctx, master) {
  const n = {};
  n.input = ctx.createGain();
  n.low = ctx.createBiquadFilter(); n.low.type = 'lowshelf'; n.low.frequency.value = 120;
  n.mid = ctx.createBiquadFilter(); n.mid.type = 'peaking'; n.mid.frequency.value = 1000; n.mid.Q.value = 0.9;
  n.high = ctx.createBiquadFilter(); n.high.type = 'highshelf'; n.high.frequency.value = 7000;
  n.comp = ctx.createDynamicsCompressor(); n.makeup = ctx.createGain();
  n.pan = ctx.createStereoPanner();
  n.vol = ctx.createGain();
  n.an = ctx.createAnalyser(); n.an.fftSize = 1024;
  n.rev = ctx.createGain(); n.dly = ctx.createGain();
  n.chain = new Plugins.Chain(ctx);
  n.apan = ctx.createStereoPanner(); n.avol = ctx.createGain();
  n.hp = ctx.createBiquadFilter(); n.hp.type = 'highpass'; n.hp.frequency.value = 10; n.hp.Q.value = 0.707;
  n.lp = ctx.createBiquadFilter(); n.lp.type = 'lowpass'; n.lp.frequency.value = Math.min(22000, ctx.sampleRate / 2 - 100); n.lp.Q.value = 0.707;
  n.input.connect(n.hp).connect(n.low).connect(n.mid).connect(n.high).connect(n.lp).connect(n.comp).connect(n.makeup).connect(n.chain.input);
  n.chain.output.connect(n.apan).connect(n.pan).connect(n.avol).connect(n.vol);
  n.vol.connect(n.an); n.vol.connect(master.input); n.vol.connect(n.rev).connect(master.revIn); n.vol.connect(n.dly).connect(master.dlyIn);
  return n;
}
function applyTrack(n, tr, soloOn, ctx) {
  const t = ctx.currentTime;
  n.low.gain.setTargetAtTime(tr.low, t, 0.01); n.mid.gain.setTargetAtTime(tr.mid, t, 0.01); n.high.gain.setTargetAtTime(tr.high, t, 0.01);
  applyTrackEq(n, tr, ctx);
  const c = tr.comp;
  n.comp.threshold.value = -36 * c; n.comp.ratio.value = 1 + 7 * c; n.comp.knee.value = 8; n.comp.attack.value = 0.006; n.comp.release.value = 0.18;
  n.makeup.gain.setTargetAtTime(dbToGain(c * 9), t, 0.01);
  n.pan.pan.setTargetAtTime(tr.pan, t, 0.01);
  const audible = !tr.mute && (!soloOn || tr.solo);
  n.vol.gain.setTargetAtTime(audible ? dbToGain(tr.vol) : 0, t, 0.008);
  n.rev.gain.setTargetAtTime(tr.rev, t, 0.01); n.dly.gain.setTargetAtTime(tr.dly, t, 0.01);
  n.chain.set(tr.fx || []);
}

// Track EQ: low cut, low shelf, parametric mid, high shelf, high cut
const EQ_DEF = { hp: 0, lowF: 120, midF: 1000, midQ: 0.9, highF: 7000, lp: 0 };
function trackEq(tr) { return Object.assign({}, EQ_DEF, tr.eq || {}); }
function applyTrackEq(n, tr, ctx) {
  const e = trackEq(tr), t = ctx.currentTime, nyq = ctx.sampleRate / 2 - 100;
  n.hp.frequency.setTargetAtTime(e.hp > 0 ? e.hp : 10, t, 0.01);
  n.lp.frequency.setTargetAtTime(e.lp > 0 ? Math.min(e.lp, nyq) : Math.min(22000, nyq), t, 0.01);
  n.low.frequency.setTargetAtTime(e.lowF, t, 0.01); n.mid.frequency.setTargetAtTime(e.midF, t, 0.01); n.mid.Q.setTargetAtTime(e.midQ, t, 0.01); n.high.frequency.setTargetAtTime(e.highF, t, 0.01);
}

// ---- track envelopes (automation) ----
function envAt(pts, beat, def) {
  if (!pts || !pts.length) return def;
  if (beat <= pts[0].b) return pts[0].v;
  for (let i = 1; i < pts.length; i++) if (beat <= pts[i].b) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * (beat - a.b) / Math.max(1e-9, b.b - a.b); }
  return pts[pts.length - 1].v;
}
function scheduleAuto(ctx, nodes, a, b, when, fresh) {
  for (const tr of P.tracks) {
    const n = nodes.get(tr.id); if (!n) continue;
    const env = tr.env || {};
    for (const [param, pts, conv] of [[n.avol.gain, env.vol, dbToGain], [n.apan.pan, env.pan, (v) => v]]) {
      if (fresh) param.cancelScheduledValues(0);
      if (!pts || !pts.length) { if (fresh) param.setValueAtTime(conv(0), Math.max(0, when)); continue; }
      param.setValueAtTime(conv(envAt(pts, T.s2b(a), 0)), when);
      // sample the curve on a 30 ms grid (plus exact points) so dB-shaped ramps sound as drawn
      const times = [];
      for (let t = a + 0.03; t < b; t += 0.03) times.push(t);
      for (const pt of pts) { const t = T.b2s(pt.b); if (t > a && t < b) times.push(t); }
      times.sort((x, y) => x - y);
      for (const t of times) param.linearRampToValueAtTime(conv(envAt(pts, T.s2b(t), 0)), when + (t - a));
      param.linearRampToValueAtTime(conv(envAt(pts, T.s2b(b), 0)), when + (b - a));
    }
  }
}

// clip gain + fade envelope; fades are equal-power unless the clip asks for linear
// clip fades in seconds; "quick fade edges" adds 5 ms de-click fades to bare clip edges
// (only where the clip actually cuts into the audio, so natural starts and ends keep their attack)
const QF = 0.003;
function clipFades(c, clen) {
  let qi = 0, qo = 0;
  if (typeof PREF === 'undefined' || PREF.quickFade !== false) {
    const q = Math.min(QF, clen / 4), A = S.assets.get(c.asset), base = A && clipBase(c);
    if (base) {
      const synced = isSynced(c, A), p = synced ? 60 / A.bpm : 0;
      const t0 = synced ? (A.downbeat || 0) + (c.offB || 0) * p : (c.offset || 0);
      const t1 = synced ? t0 + c.len * p : t0 + clen;
      const D = base.duration, w0 = c.loop ? fmod(t0, D) : t0, w1 = c.loop ? fmod(t1, D) : t1;
      qi = w0 > 0.0005 && w0 < D - 0.0005 ? q : 0;
      qo = w1 > 0.0005 && w1 < D - 0.0005 ? q : 0;
    }
  }
  return [Math.min(Math.max(c.fadeIn || 0, qi), clen), Math.min(Math.max(c.fadeOut || 0, qo), clen)];
}
function clipGainAt(c, x, clen) {
  const gl = dbToGain(c.gain || 0), [fi, fo] = clipFades(c, clen);
  const shape = (u) => (c.fadeCurve === 'lin' ? u : Math.sin(clamp(u, 0, 1) * Math.PI / 2));
  let g = gl;
  if (fi > 0 && x < fi) g *= shape(x / fi);
  if (fo > 0 && x > clen - fo) g *= shape((clen - x) / fo);
  return g;
}
function scheduleClipEnv(param, c, local, dur, clen, t0, cut) {
  const end = local + dur, [fi, fo] = clipFades(c, clen);
  const declick = local > 0.002 ? 0.004 : 0;
  param.setValueAtTime(declick ? 0 : clipGainAt(c, local, clen), t0);
  if (declick) param.linearRampToValueAtTime(clipGainAt(c, local + declick, clen), t0 + declick);
  const pts = [];
  const grid = (x0, x1) => { for (let x = Math.max(x0, local + declick); x <= Math.min(x1, end) + 1e-9; x += 0.02) pts.push(x); pts.push(Math.min(x1, end)); };
  if (fi > 0 && local + declick < fi) grid(local + declick, fi);
  if (fo > 0 && end > clen - fo) { pts.push(Math.max(clen - fo, local + declick)); grid(clen - fo, end); }
  pts.sort((x, y) => x - y);
  let last = -1;
  for (const x of pts) { if (x <= last + 1e-6 || x < local + declick) continue; param.linearRampToValueAtTime(clipGainAt(c, x, clen), t0 + (x - local)); last = x; }
  if (cut) { param.setValueAtTime(clipGainAt(c, end - 0.004, clen), t0 + dur - 0.004); param.linearRampToValueAtTime(0, t0 + dur); }
}

// schedule clips into ctx. first=true: clips already sounding at `a` (seconds) are started mid-way.
function scheduleClips(ctx, nodes, a, b, when, first, list, capAtB, chains) {
  for (const tr of P.tracks) {
    const n = nodes.get(tr.id);
    if (!n) continue;
    for (const clip of tr.clips) {
      const A = S.assets.get(clip.asset); if (!A) continue;
      const base = stemBuffer(A, clip.stem); if (!base) continue;
      const cs = T.b2s(clip.start), ce = T.b2s(clip.start + clip.len);
      const starts = cs >= a - 1e-9 && cs < b;
      const running = first && cs < a && ce > a + 1e-4;
      if (!starts && !running) continue;
      const s0 = Math.max(cs, a), s1 = capAtB ? Math.min(ce, b) : ce;
      if (s1 - s0 < 1e-4) continue;
      const local = s0 - cs, dur = s1 - s0, clen = ce - cs;
      const t0 = when + (s0 - a);
      const srcs = [];
      const mk = (buf, rate, loop) => { const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate; if (loop) { src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration; } srcs.push(src); return src; };
      const g = ctx.createGain();
      const semis = clipSemis(clip, tr);
      if (!isSynced(clip, A)) {
        const buf = (semis && getStretch(A, clip.stem, null, semis)) || base;
        let off = (clip.offset || 0) + local;
        if (clip.loop) off = fmod(off, base.duration); else if (off >= base.duration) continue;
        const src = mk(buf, 1, clip.loop);
        src.connect(g); src.start(t0, off); src.stop(t0 + dur + 0.001);
      } else {
        const period = assetBeats(A, base), [lo, hi] = srcBeatRange(A, base), db = A.downbeat || 0;
        const ps = T.pieces(T.s2b(s0), T.s2b(s1));
        const X = 0.006;
        ps.forEach((p, k) => {
          const R = p.ramp ? Math.round(p.bpm) : Math.round(p.bpm * 100) / 100;
          let buf, Rb;
          if (clip.keylock === false) { buf = (semis && getStretch(A, clip.stem, A.bpm, semis)) || base; Rb = A.bpm; }  // varispeed, like vinyl
          else { buf = getStretch(A, clip.stem, R, semis); Rb = R; if (!buf) { buf = base; Rb = A.bpm; } }  // still stretching: varispeed meanwhile
          const rate = p.bpm / Rb;
          let p0 = p.p0;
          let sb = (clip.offB || 0) + (p0 - clip.start);
          if (clip.loop) sb = fmod(sb - lo, period) + lo;
          else {
            if (sb >= hi) return;
            if (sb < lo) { p0 += lo - sb; sb = lo; if (p0 >= p.p1 - 1e-9) return; }
          }
          const pt0 = when + (T.b2s(p0) - a), pt1 = when + (T.b2s(p.p1) - a);
          const src = mk(buf, rate, clip.loop);
          let off = (db + sb * 60 / A.bpm) * A.bpm / Rb, st = Math.max(t0, pt0), en = pt1;
          if (ps.length > 1) {
            const pg = ctx.createGain();
            if (k > 0) { const lead = Math.min(X / 2, off / rate); st = pt0 - lead; off -= lead * rate; pg.gain.setValueAtTime(0, st); pg.gain.linearRampToValueAtTime(1, pt0 + X / 2); }
            if (k < ps.length - 1) { en = pt1 + X / 2; pg.gain.setValueAtTime(1, pt1 - X / 2); pg.gain.linearRampToValueAtTime(0, en); }
            src.connect(pg).connect(g);
          } else src.connect(g);
          src.start(st, Math.max(0, off)); src.stop(en + 0.001);
        });
        if (!srcs.length) continue;
      }
      scheduleClipEnv(g.gain, clip, local, dur, clen, t0, capAtB && s1 < ce);
      const chain = new Plugins.Chain(ctx); chain.set(clip.fx || []);
      g.connect(chain.input); chain.output.connect(n.input);
      if (chains) {
        let set = chains.get(clip.id); if (!set) chains.set(clip.id, (set = new Set()));
        set.add(chain);
        srcs[srcs.length - 1].onended = () => setTimeout(() => { set.delete(chain); try { chain.output.disconnect(); } catch (e) { } }, 6000);
      }
      if (list) list.push(...srcs);
    }
  }
}

// DynamicsCompressor nodes delay audio by a fixed look-ahead; measure it once per sample rate
const latCache = new Map();
async function graphLatency(sr) {
  if (latCache.has(sr)) return latCache.get(sr);
  let d = 0;
  try {
    const oc = new OfflineAudioContext(1, Math.round(sr * 0.05), sr);
    const b = oc.createBuffer(1, 1, sr); b.getChannelData(0)[0] = 0.25;
    const src = oc.createBufferSource(); src.buffer = b;
    const c = oc.createDynamicsCompressor(); c.threshold.value = 0; c.ratio.value = 1;
    src.connect(c).connect(oc.destination); src.start(0);
    const r = (await oc.startRendering()).getChannelData(0);
    let bi = 0, bv = 0; for (let i = 0; i < r.length; i++) if (Math.abs(r[i]) > bv) { bv = Math.abs(r[i]); bi = i; }
    d = 2 * bi / sr;                       // one in every track, one on the master
  } catch (e) { }
  latCache.set(sr, d);
  return d;
}

const Engine = {
  ctx: null, master: null, nodes: new Map(), playing: false, sources: [], segs: [], timer: null,
  recording: false, rec: null, deckOut: null, previewSrc: null, clipChains: new Map(),
  ensure(resume = true) {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const opt = { latencyHint: (typeof PREF !== 'undefined' && PREF.latency) || 'interactive' };
      if (typeof PREF !== 'undefined' && PREF.sampleRate) opt.sampleRate = PREF.sampleRate;
      try { this.ctx = new AC(opt); } catch (e) { this.ctx = new AC({ latencyHint: 'interactive' }); }
      this.master = buildMaster(this.ctx, this.ctx.destination);
      this.syncTracks();
      $('#statusSr').textContent = (this.ctx.sampleRate / 1000).toFixed(1) + ' kHz';
    }
    if (resume && this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  // rebuild the audio engine (latency or sample-rate change)
  async recreate() {
    const was = this.playing ? this.posBeats() : null;
    this.halt(); this.stopPreview(); this.stopAudition && this.stopAudition();
    const old = this.ctx;
    this.ctx = null; this.master = null; this.nodes.clear(); this.clipChains.clear(); this.recMode = null; this.previewBus = null;
    if (old) { try { await old.close(); } catch (e) { } }
    Deck.unloadAudio && Deck.unloadAudio();
    this.ensure();
    if (was != null) this.play(was);
  },
  // preview bus: straight to the speakers, bypassing the mix (Explorer and Media auditioning)
  audition(buf, { offset = 0, rate = 1, onEnd } = {}) {
    const ctx = this.ensure();
    this.stopAudition();
    if (!this.previewBus) { this.previewBus = ctx.createGain(); this.previewBus.connect(ctx.destination); }
    this.previewBus.gain.value = dbToGain(typeof PREF !== 'undefined' ? PREF.previewVol : -6);
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    src.connect(this.previewBus); src.start(ctx.currentTime + 0.01, offset);
    src.onended = () => { if (this.audSrc === src) { this.audSrc = null; onEnd && onEnd(); } };
    this.audSrc = src; src.t0 = ctx.currentTime + 0.01; src.off = offset; src.rate = rate;
    return src;
  },
  auditionPos() { const s = this.audSrc; if (!s || !this.ctx) return null; return s.off + Math.max(0, this.ctx.currentTime - s.t0) * s.rate; },
  setPreviewVol(db) { if (this.previewBus) this.previewBus.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02); },
  stopAudition() { if (this.audSrc) { const s = this.audSrc; this.audSrc = null; try { s.stop(); } catch (e) { } } },
  syncTracks() {
    if (!this.ctx) return;
    const ids = new Set(P.tracks.map((t) => t.id));
    for (const [id, n] of this.nodes) if (!ids.has(id)) { try { n.vol.disconnect(); } catch (e) { } this.nodes.delete(id); }
    for (const t of P.tracks) if (!this.nodes.has(t.id)) this.nodes.set(t.id, buildTrack(this.ctx, this.master));
    this.applyAll();
  },
  applyAll() {
    if (!this.ctx) return;
    const soloOn = P.tracks.some((t) => t.solo);
    for (const t of P.tracks) { const n = this.nodes.get(t.id); if (n) applyTrack(n, t, soloOn, this.ctx); }
    applyMaster(this.master, this.ctx);
  },
  loopSec() { return { on: P.loop.on && P.loop.end > P.loop.start, a: T.b2s(P.loop.start), b: T.b2s(P.loop.end) }; },
  updateClipFx(clip) { const set = this.clipChains.get(clip.id); if (set) for (const ch of set) ch.set(clip.fx || []); },
  play(fromBeat = P.cursor) {
    const ctx = this.ensure();
    if (this.playing) this.stopSources();
    Deck.pause && Deck.pause();
    this.syncTracks();
    planStretches();
    this.playing = true;
    const L = this.loopSec();
    let from = T.b2s(fromBeat);
    if (L.on && from >= L.b) from = L.a;
    this.nextPos = from; this.nextWhen = ctx.currentTime + 0.06; this.first = true;
    this.sources = []; this.segs = [];
    this.pump();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), 40);
    bus.emit('transport');
  },
  pump() {
    if (!this.playing) return;
    const ctx = this.ctx, L = this.loopSec();
    while (this.nextWhen < ctx.currentTime + 1.2) {
      const a = this.nextPos;
      const inLoop = L.on && a < L.b - 1e-6;
      const b = inLoop ? L.b : a + 2;
      const first = this.first || inLoop;
      scheduleClips(ctx, this.nodes, a, b, this.nextWhen, first, this.sources, inLoop, this.clipChains);
      scheduleAuto(ctx, this.nodes, a, b, this.nextWhen, this.first);
      if (P.metro || this.recording) this.clicks(a, b, this.nextWhen);
      this.segs.push({ when: this.nextWhen, a, b });
      this.nextWhen += b - a;
      this.nextPos = inLoop ? L.a : b;
      this.first = false;
    }
    const now = ctx.currentTime;
    if (this.segs.length > 8) this.segs = this.segs.filter((s) => s.when + (s.b - s.a) > now - 1);
    if (this.sources.length > 400) this.sources = this.sources.slice(-300);
  },
  clicks(a, b, when) {
    const ctx = this.ctx, B1 = T.s2b(b);
    for (let bt = Math.ceil(T.s2b(a) - 1e-6); bt < B1 - 1e-6; bt++) {
      const t = when + (T.b2s(bt) - a);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = bt % P.bpb === 0 ? 1760 : 1180;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      if (!this.clickDelay || this.clickDelay.context !== ctx) { this.clickDelay = ctx.createDelay(0.2); this.clickDelay.connect(ctx.destination); graphLatency(ctx.sampleRate).then((d) => { this.clickDelay.delayTime.value = d; }); }
      o.connect(g).connect(this.clickDelay);
      o.start(t); o.stop(t + 0.06);
      this.sources.push(o);
    }
  },
  posSec() {
    if (!this.playing || !this.ctx) return T.b2s(P.cursor);
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0) * 0;
    let seg = null;
    for (const s of this.segs) if (now >= s.when) seg = s;
    if (!seg) return this.segs.length ? this.segs[0].a : T.b2s(P.cursor);
    return Math.min(seg.b, seg.a + (now - seg.when));
  },
  posBeats() { return T.s2b(this.posSec()); },
  stopSources() {
    for (const s of this.sources) { try { s.stop(); } catch (e) { } }
    this.sources = [];
  },
  pause() {
    if (!this.playing) return;
    const p = this.posBeats();
    this.halt();
    P.cursor = Math.max(0, p);
    bus.emit('transport');
  },
  stop() {
    const wasPlaying = this.playing;
    this.halt();
    if (!wasPlaying) P.cursor = 0;
    bus.emit('transport');
  },
  halt() {
    if (this.recording) this.stopRecord();
    clearInterval(this.timer); this.timer = null;
    this.stopSources();
    this.playing = false;
  },
  toggle() { if (this.playing) this.pause(); else this.play(P.cursor); },
  refresh() {
    clearTimeout(this._plan); this._plan = setTimeout(() => planStretches(), 250);   // prepare stretched audio in the background
    if (!this.ctx) return;
    this.applyAll();
    if (!this.playing || this.recording) return;
    const p = this.posBeats();
    this.stopSources();
    this.playing = false;
    this.play(p);
  },
  refreshSoon() { clearTimeout(this._rs); this._rs = setTimeout(() => this.refresh(), 30); },

  // ---- recording ----
  async startRecord() {
    const ctx = this.ensure();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Recording needs microphone access, which this browser window does not allow.', 'err'); return; }
    if (this.recording) return;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { toast('Microphone access was blocked. Allow it in the browser to record.', 'err'); return; }
    // capture node: AudioWorklet when allowed, ScriptProcessor fallback (e.g. pages opened from disk)
    if (this.recMode == null) {
      const code = "class R extends AudioWorkletProcessor{process(i){const x=i[0];if(x&&x.length)this.port.postMessage({t:currentTime,ch:x.map(c=>c.slice())});return true}};registerProcessor('rush-rec',R);";
      this.recMode = 'sp';
      for (const url of ['data:text/javascript;base64,' + btoa(code), URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))]) {
        try { await ctx.audioWorklet.addModule(url); this.recMode = 'wl'; break; } catch (e) { }
      }
    }
    let tr = P.tracks.find((t) => t.arm);
    Hist.push();
    if (!tr) { tr = newTrack('Recording'); tr.arm = true; P.tracks.push(tr); this.syncTracks(); bus.emit('project'); }
    const src = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain(); sink.gain.value = 0;
    const chunks = [];
    let node;
    const startBeat = P.cursor;
    const pre = (typeof PREF !== 'undefined' ? PREF.countIn : 0) * P.bpb;   // count-in bars before the cursor
    this.recording = true;
    this.play(startBeat - pre);
    const startT = (this.segs.length ? this.segs[0].when : ctx.currentTime) + (T.b2s(startBeat) - T.b2s(startBeat - pre));
    if (this.recMode === 'wl') {
      node = new AudioWorkletNode(ctx, 'rush-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => { if (e.data.t + 128 / ctx.sampleRate >= startT) chunks.push(e.data); };
    } else {
      node = ctx.createScriptProcessor(2048, 2, 1);
      node.onaudioprocess = (e) => {
        const ib = e.inputBuffer, t = e.playbackTime - ib.duration;
        if (t + ib.duration < startT) return;
        const ch = []; for (let c = 0; c < ib.numberOfChannels; c++) ch.push(ib.getChannelData(c).slice());
        chunks.push({ t, ch });
      };
      node.port = { set onmessage(v) { node.onaudioprocess = v; } };
    }
    src.connect(node).connect(sink).connect(ctx.destination);
    this.rec = { stream, src, node, sink, chunks, track: tr, startBeat, startT };
    $('#tRec').setAttribute('aria-pressed', 'true');
    status('Recording on ' + tr.name + '…');
  },
  stopRecord() {
    const r = this.rec; if (!r) return;
    this.recording = false; this.rec = null;
    try { r.node.port.onmessage = null; r.src.disconnect(); r.node.disconnect(); r.sink.disconnect(); } catch (e) { }
    r.stream.getTracks().forEach((t) => t.stop());
    $('#tRec').setAttribute('aria-pressed', 'false');
    const sr = this.ctx.sampleRate;
    if (!r.chunks.length) { status('Nothing recorded'); return; }
    const nch = Math.min(2, r.chunks[0].ch.length);
    let total = 0; for (const c of r.chunks) total += c.ch[0].length;
    const lat = Math.round(((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + (latCache.get(sr) || 0)) * sr);
    const skip = Math.max(0, Math.round((r.startT - r.chunks[0].t) * sr)) + lat;
    const chs = [];
    for (let c = 0; c < nch; c++) {
      const d = new Float32Array(Math.max(1, total - skip)); let o = -skip;
      for (const ch of r.chunks) { const src = ch.ch[c] || ch.ch[0]; for (let i = 0; i < src.length; i++, o++) if (o >= 0 && o < d.length) d[o] = src[i]; }
      chs.push(d);
    }
    const buf = makeBuffer(chs, sr);
    const n = [...S.assets.values()].filter((a) => a.name.startsWith('Recording')).length + 1;
    const A = addAsset('Recording ' + n, buf, { bpm: T.bpmAt(r.startBeat), beats: buf.duration * T.bpmAt(r.startBeat) / 60, isLoop: false });
    r.track.clips.push({ id: uid('c'), asset: A.id, start: r.startBeat, len: T.lenFor(r.startBeat, buf.duration), offset: 0, offB: 0, sync: false, loop: false, gain: 0, fadeIn: 0, fadeOut: 0, fx: [] });
    bus.emit('project');
    toast('Recorded ' + fmtShort(buf.duration) + ' to ' + r.track.name, 'ok');
    status('Ready');
  },

  // ---- offline render ----
  async render({ fromBeat = 0, toBeat = null, sr = null, tail = 2, noLimiter = false } = {}) {
    await ensureStretched();
    const keepLim = P.master.limiter;
    if (noLimiter) P.master.limiter = false;   // the mastering stage applies a true-peak limiter instead
    try { return await this._render(fromBeat, toBeat, sr, tail); } finally { P.master.limiter = keepLim; }
  },
  async _render(fromBeat, toBeat, sr, tail) {
    const end = toBeat == null ? projectEndBeats() : toBeat;
    if (end <= fromBeat) throw new Error('The project is empty. Add clips before exporting.');
    sr = sr || (this.ctx ? this.ctx.sampleRate : 44100);
    const a = T.b2s(fromBeat), b = T.b2s(end);
    const pre = 0.1;                       // silent pre-roll lets dynamics processors settle
    const lat = await graphLatency(sr);    // look-ahead delay of the track compressor + master limiter
    const len = Math.ceil((b - a + tail + pre + lat) * sr);
    const oc = new OfflineAudioContext(2, len, sr);
    const master = buildMaster(oc, oc.destination);
    const nodes = new Map();
    const soloOn = P.tracks.some((t) => t.solo);
    for (const t of P.tracks) { const n = buildTrack(oc, master); nodes.set(t.id, n); applyTrack(n, t, soloOn, oc); }
    scheduleClips(oc, nodes, a, b, pre, true, null, true);
    scheduleAuto(oc, nodes, a, b, pre, true);
    const r = await oc.startRendering();
    const skip = Math.round((pre + lat) * sr);   // exported audio lines up sample-accurately with the timeline
    return makeBuffer([0, 1].map((ch) => r.getChannelData(ch).slice(skip)), sr);
  },
  // plays a standalone buffer (editor preview); returns handle
  playBuffer(buf, offset = 0, dur, onEnd) {
    const ctx = this.ensure();
    this.stopPreview();
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.connect(this.master.input);
    src.start(ctx.currentTime + 0.02, offset, dur);
    src.onended = () => { if (this.previewSrc === src) { this.previewSrc = null; onEnd && onEnd(); } };
    this.previewSrc = src; src.t0 = ctx.currentTime + 0.02; src.off = offset;
    return src;
  },
  stopPreview() { if (this.previewSrc) { const s = this.previewSrc; this.previewSrc = null; try { s.stop(); } catch (e) { } } },
};

// ---- project save / load (.rush) ------------------------------------------------
const Project = {
  async toBlob() {
    const usedStems = new Set();
    for (const t of P.tracks) for (const c of t.clips) if (c.stem) usedStems.add(c.asset);
    const parts = [], metas = [];
    let off = 0;
    const pushF32 = (arr) => { parts.push(arr); const o = off; off += arr.byteLength; return o; };
    for (const A of S.assets.values()) {
      const m = { id: A.id, name: A.name, sr: A.buffer.sampleRate, len: A.buffer.length, nch: A.buffer.numberOfChannels, bpm: A.bpm, beats: A.beats, isLoop: A.isLoop, key: A.key, generated: A.generated, downbeat: A.downbeat || 0, markers: A.markers || [], beatmapped: !!A.beatmapped, revOf: A.revOf || null, data: [] };
      for (const ch of bufferChannels(A.buffer)) m.data.push(pushF32(ch));
      if (usedStems.has(A.id) && A.stems.state === 'done') {
        m.stems = {};
        for (const k in A.stems.buffers) m.stems[k] = bufferChannels(A.stems.buffers[k]).map((ch) => pushF32(ch));
      }
      metas.push(m);
    }
    const json = new TextEncoder().encode(JSON.stringify({ app: 'Rush Music Studio', version: 1, project: P, assets: metas }));
    const head = new ArrayBuffer(12), dv = new DataView(head);
    dv.setUint32(0, 0x48535552, true); dv.setUint32(4, 1, true); dv.setUint32(8, json.byteLength, true);
    const padLen = (4 - ((12 + json.byteLength) % 4)) % 4;
    return new Blob([head, json, new Uint8Array(padLen), ...parts], { type: 'application/octet-stream' });
  },
  async fromBuffer(ab) {
    const dv = new DataView(ab);
    if (dv.getUint32(0, true) !== 0x48535552) throw new Error('This is not a Rush project file.');
    const jl = dv.getUint32(8, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 12, jl)));
    const base = 12 + jl + ((4 - ((12 + jl) % 4)) % 4);
    Engine.halt(); Deck.unload && Deck.unload();
    S.assets.clear();
    for (const m of meta.assets) {
      const chs = m.data.map((o) => new Float32Array(ab, base + o, m.len).slice());
      const A = addAsset(m.name, makeBuffer(chs, m.sr), { id: m.id, bpm: m.bpm, beats: m.beats, isLoop: m.isLoop, key: m.key, generated: m.generated, downbeat: m.downbeat || 0 });
      A.markers = m.markers || []; A.beatmapped = !!m.beatmapped; if (m.revOf) A.revOf = m.revOf;
      if (!m.bpm) analyzeAsset(A);
      if (m.stems) {
        const bufs = {}; for (const k in m.stems) bufs[k] = makeBuffer(m.stems[k].map((o) => new Float32Array(ab, base + o, m.len).slice()), m.sr);
        A.stems.buffers = bufs; A.stems.state = 'done'; A.stems.peaks = {}; for (const k in bufs) A.stems.peaks[k] = computePeaks(bufs[k]);
      }
    }
    P = Object.assign(newProject(), meta.project);
    P.master = Object.assign(newProject().master, meta.project.master || {});
    migrateProject();
    Hist.undo = []; Hist.redo = [];
    $('#bpmInput').value = P.bpm; $('#projName').value = P.name; $('#bpbSel').value = P.bpb;
    if (Engine.ctx) { Engine.nodes.clear(); Engine.master = buildMaster(Engine.ctx, Engine.ctx.destination); Engine.syncTracks(); }
    S.selClip = null; S.editAsset = null;
    bus.emit('assets'); bus.emit('project');
  },
  async save() {
    status('Saving project…');
    const blob = await this.toBlob();
    downloadBlob(blob, safeName(P.name) + '.rush');
    S.dirty = false; $('#statusSave').textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    status('Project saved (' + (blob.size / 1048576).toFixed(1) + ' MB)');
  },
  async load(file) {
    try { await this.fromBuffer(await file.arrayBuffer()); toast('Opened ' + file.name, 'ok'); S.dirty = false; $('#statusSave').textContent = 'Opened'; }
    catch (e) { toast(e.message || 'Could not open that project.', 'err'); }
  },
};

// ---- autosave to IndexedDB (crash recovery) --------------------------------------
const Autosave = {
  t: null, busy: false, enabled: true,
  db() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open('rush-music-studio', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  },
  schedule() { if (!this.enabled) return; clearTimeout(this.t); this.t = setTimeout(() => this.save(), 5000); },
  async save() {
    if (this.busy || S.booting) return; this.busy = true;
    try {
      const blob = await Project.toBlob();
      const db = await this.db();
      await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ blob, when: Date.now(), name: P.name }, 'autosave'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    } catch (e) { /* storage unavailable: ignore */ }
    this.busy = false;
  },
  async get() {
    try {
      const db = await this.db();
      return await new Promise((res) => { const tx = db.transaction('kv', 'readonly'); const r = tx.objectStore('kv').get('autosave'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
    } catch (e) { return null; }
  },
};
