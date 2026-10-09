// ---------------------------------------------------------------------------
// AI stems: front end for the Rush neural engine (HTDemucs v4 network).
// The model file comes with the desktop app (models/ next to the page), or can
// be installed once from a file (it is then kept in this browser's storage).
// Separation runs in a worker on the graphics card (WebGPU) or on all CPU cores
// (WebAssembly SIMD), and finished stretches of stems stream back as they are
// ready, starting at the playhead.
// ---------------------------------------------------------------------------
const AI = (() => {
  const st = { status: 'unknown', source: '', model: null, worker: null, ep: '', threads: 1, chunkMs: 0, err: '', seq: 0, jobs: new Map(), readyP: null, gpu: '' };
  const base = () => location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  const KEYMAP = { drums: 'drums', bass: 'bass', other: 'melody', vocals: 'vocals' };
  const MODEL_URL = 'https://github.com/DeeJayKyle/rush-music-studio/releases/latest';

  // ---- model storage (IndexedDB) ----
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('rush-ai', 1); r.onupgradeneeded = () => r.result.createObjectStore('m'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function idbGet(k) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('m').objectStore('m').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (e) { return null; } }
  async function idbPut(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('m', 'readwrite'); tx.objectStore('m').put(v, k); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); }); }
  async function idbDel(k) { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction('m', 'readwrite'); tx.objectStore('m').delete(k); tx.oncomplete = res; tx.onerror = res; }); } catch (e) { } }
  const isModel = (ab) => ab && ab.byteLength > 1e6 && new DataView(ab).getUint32(0, true) === 0x4d545352;

  async function findModel() {
    // 1) shipped next to the app (desktop app, or a web server with models/)
    if (location.protocol !== 'file:' && location.protocol !== 'about:') {
      try {
        const r = await fetch(base() + 'models/manifest.json', { cache: 'no-store' });
        if (r.ok) {
          const man = await r.json();
          if (man.format === 'rush-stemnet') { const mr = await fetch(base() + 'models/' + man.model); if (mr.ok) { const ab = await mr.arrayBuffer(); if (isModel(ab)) { st.source = 'app'; return ab; } } }
        }
      } catch (e) { }
    }
    // 2) installed into this browser
    const ab = await idbGet('htdemucs');
    if (isModel(ab)) { st.source = 'installed'; return ab; }
    return null;
  }
  async function probe() {
    if (st.status === 'ready' || st.status === 'loading') return true;
    if (st.model) return true;
    const ab = await findModel();
    if (!ab) { st.status = 'none'; bus.emit('ai'); return false; }
    st.model = ab; return true;
  }
  function kernels() {
    const j = JSON.parse(document.getElementById('rush-ai-kern').textContent);
    const dec = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
    return { simd: dec(j.simd), fma: dec(j.fma) };
  }
  function ready() {
    if (st.readyP) return st.readyP;
    st.readyP = (async () => {
      if (!(await probe())) { st.readyP = null; return false; }
      st.status = 'loading'; bus.emit('ai');
      const src = document.getElementById('rush-ai-src').textContent;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      st.worker = w;
      const ok = await new Promise((res) => {
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { st.ep = m.ep; st.threads = m.threads; st.gpu = m.gpu || ''; res(true); return; }
          if (m.type === 'failed') { st.err = m.error || 'failed'; res(false); return; }
          if (m.type === 'device') { st.ep = m.ep; st.threads = m.threads; bus.emit('ai'); return; }
          if (m.type === 'log') { console.log('AI:', m.text); return; }
          const j = st.jobs.get(m.id); if (!j) return;
          if (m.type === 'region') j.region(m.a, m.b, m.data);
          else if (m.type === 'progress') { if (m.chunkMs) st.chunkMs = m.chunkMs; j.progress(m.p); }
          else if (m.type === 'done') j.done(m.ms);
          else if (m.type === 'error') j.fail(new Error(m.error));
        };
        w.onerror = (e) => { st.err = e.message || 'worker error'; res(false); };
        const prefer = (typeof PREF !== 'undefined' && PREF.aiDevice) || 'auto';
        const model = st.model.slice(0);
        w.postMessage({ type: 'init', model, kernels: kernels(), cores: navigator.hardwareConcurrency || 4, memGB: navigator.deviceMemory || 8, prefer: prefer === 'wasm' ? 'cpu' : prefer, maxThreads: (typeof PREF !== 'undefined' && PREF.aiThreads) || 0 }, [model]);
      });
      if (!ok) { console.warn('AI stems unavailable:', st.err); try { w.terminate(); } catch (e) { } st.worker = null; }
      st.status = ok ? 'ready' : 'failed';
      bus.emit('ai');
      return ok;
    })();
    return st.readyP;
  }
  // install the model from a file the user picked (kept in this browser)
  async function install(file) {
    const ab = await file.arrayBuffer();
    if (!isModel(ab)) throw new Error('That is not a Rush AI model file (rush-htdemucs.rsm).');
    await idbPut('htdemucs', ab);
    st.model = ab; st.status = 'unknown'; st.readyP = null; st.err = '';
    if (st.worker) { try { st.worker.terminate(); } catch (e) { } st.worker = null; }
    bus.emit('ai');
    return ready();
  }
  async function uninstall() { await idbDel('htdemucs'); if (st.source === 'installed') { st.model = null; st.status = 'none'; st.readyP = null; if (st.worker) st.worker.terminate(); st.worker = null; bus.emit('ai'); } }
  // restart with new device preferences
  function restart() { if (st.worker) { try { st.worker.terminate(); } catch (e) { } } st.worker = null; st.readyP = null; st.status = st.model ? 'unknown' : st.status; for (const j of st.jobs.values()) j.fail(new Error('restarted')); return ready(); }

  // resample a buffer to the model rate (44.1 kHz stereo)
  async function toModelRate(buf, sr) {
    if (buf.sampleRate === sr && buf.numberOfChannels >= 2) return [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()];
    const oc = new OfflineAudioContext(2, Math.ceil(buf.duration * sr), sr);
    const s = oc.createBufferSource(); s.buffer = buf; s.channelCountMode = 'explicit';
    if (buf.numberOfChannels === 1) { const m = oc.createChannelMerger(2); s.connect(m, 0, 0); s.connect(m, 0, 1); m.connect(oc.destination); } else s.connect(oc.destination);
    s.start(); const r = await oc.startRendering();
    return [r.getChannelData(0).slice(), r.getChannelData(1).slice()];
  }
  async function resampleTo(chs, from, to, len) {
    if (from === to) return chs.map((c) => (c.length === len ? c : (() => { const y = new Float32Array(len); y.set(c.subarray(0, len)); return y; })()));
    const oc = new OfflineAudioContext(2, len, to);
    const s = oc.createBufferSource(); s.buffer = makeBuffer(chs, from); s.connect(oc.destination); s.start();
    const r = await oc.startRendering();
    return [r.getChannelData(0).slice(), r.getChannelData(1).slice()];
  }
  const SOURCES = ['drums', 'bass', 'other', 'vocals'];
  // separate an asset. onRegion(aSec, bSec, {vocals:[L,R], …}, sr) streams 44.1 kHz pieces as they finish.
  function separate(A, { from = 0, onRegion, onProgress, overlap, shifts, priority = 1 } = {}) {
    const id = ++st.seq, sr = 44100;
    const promise = new Promise((resolve, reject) => {
      (async () => {
        const [L, R] = await toModelRate(A.buffer, sr);
        const len = L.length;
        const full = {}; for (const k of Object.values(KEYMAP)) full[k] = [new Float32Array(len), new Float32Array(len)];
        st.jobs.set(id, {
          region: (a, b, data) => {
            const parts = {};
            SOURCES.forEach((name, s) => { const k = KEYMAP[name]; full[k][0].set(data[s * 2], a); full[k][1].set(data[s * 2 + 1], a); parts[k] = [full[k][0].subarray(a, b), full[k][1].subarray(a, b)]; });
            onRegion && onRegion(a / sr, b / sr, parts, sr);
          },
          progress: (p) => onProgress && onProgress(p),
          done: async (ms) => {
            st.jobs.delete(id);
            try { const out = {}; for (const k in full) out[k] = await resampleTo(full[k], sr, A.buffer.sampleRate, A.buffer.length); resolve({ stems: out, ms }); }
            catch (e) { reject(e); }
          },
          fail: (e) => { st.jobs.delete(id); reject(e); },
        });
        const P = typeof PREF !== 'undefined' ? PREF : {};
        st.worker.postMessage({ type: 'separate', id, L, R, at: Math.round(from * sr), overlap: overlap ?? P.aiOverlap ?? 0.25, shifts: shifts ?? (P.aiQuality === 'ultra' ? 2 : 1), priority }, [L.buffer, R.buffer]);
      })().catch(reject);
    });
    return {
      promise,
      focus: (sec, pri) => st.worker && st.worker.postMessage({ type: 'focus', id, at: Math.round(sec * sr), priority: pri }),
      priority: (pri) => st.worker && st.worker.postMessage({ type: 'priority', id, priority: pri }),
      cancel: () => st.worker && st.worker.postMessage({ type: 'cancel', id }),
    };
  }
  function describe() {
    if (st.status === 'ready') return 'AI (HTDemucs) on ' + (st.ep === 'webgpu' ? 'the graphics card' + (st.gpu ? ' (' + st.gpu + ')' : '') : st.threads + ' CPU core' + (st.threads > 1 ? 's' : '')) + (st.chunkMs ? ' · ' + (7.8 / (st.chunkMs / 1000) * (st.ep === 'webgpu' ? 1 : st.threads) * 0.75).toFixed(1) + '× real-time' : '');
    if (st.status === 'loading') return 'Starting the AI separator…';
    if (st.status === 'failed') return 'AI separator could not start (' + st.err + '): using the fast separator';
    if (st.status === 'none') return 'Fast separator · install the AI model for studio-quality stems';
    return 'Separation runs fully offline on this computer.';
  }
  return {
    probe, ready, install, uninstall, restart, separate, describe, MODEL_URL,
    get nativeErr() { return ''; }, get status() { return st.status; }, get ep() { return st.ep; }, get chunkMs() { return st.chunkMs; }, get source() { return st.source; }, get threads() { return st.threads; },
  };
})();
