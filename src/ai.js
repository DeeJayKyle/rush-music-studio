// ---------------------------------------------------------------------------
// AI stems: front end for the HTDemucs worker. Finds the model shipped with the
// desktop app (models/manifest.json next to the page), starts ONNX Runtime in a
// worker and streams finished stretches of stems back as they are ready.
// ---------------------------------------------------------------------------
const AI = (() => {
  const st = { status: 'unknown', manifest: null, worker: null, ep: '', threads: 1, chunkMs: 0, err: '', seq: 0, jobs: new Map(), readyP: null };
  const base = () => location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
  const KEYMAP = { drums: 'drums', bass: 'bass', other: 'melody', vocals: 'vocals' };

  async function probe() {
    if (st.manifest || st.status === 'none') return !!st.manifest;
    try {
      if (location.protocol === 'file:') throw new Error('file page');
      const r = await fetch(base() + 'models/manifest.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('no model');
      st.manifest = await r.json();
      return true;
    } catch (e) { st.status = 'none'; return false; }
  }
  // start the runtime once; resolves true when AI separation is usable
  function ready() {
    if (st.readyP) return st.readyP;
    st.readyP = (async () => {
      if (!(await probe())) return false;
      st.status = 'loading'; bus.emit('ai');
      // desktop app: native separator process first (GPU via DirectML / all CPU cores), then WebAssembly
      if (window.rushDesktop && window.rushDesktop.native && (typeof PREF === 'undefined' || PREF.aiDevice !== 'wasm')) {
        const port = await new Promise((res) => {
          const on = (e) => { if (e.data && e.data.rushAIPort && e.ports[0]) { window.removeEventListener('message', on); res(e.ports[0]); } };
          window.addEventListener('message', on);
          window.rushDesktop.requestAIPort();
          setTimeout(() => { window.removeEventListener('message', on); res(null); }, 8000);
        });
        if (!port) st.nativeErr = 'no channel to the native separator';
        else if (await start(port, true)) return true;
        else st.nativeErr = st.err || 'no reply from the native separator';
      }
      const src = document.getElementById('rush-ai-src').textContent;
      return start(new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))), false);
    })();
    return st.readyP;
  }
  async function start(w, native) {
    {
      st.worker = w; st.native = native;
      const ok = await new Promise((res) => {
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { st.ep = m.ep; st.threads = m.threads; st.chunkMs = m.chunkMs; st.diag = m; res(true); return; }
          if (m.type === 'failed') { st.err = m.error || 'failed'; res(false); return; }
          if (m.type === 'log') { console.log('AI:', m.text); return; }
          const j = st.jobs.get(m.id); if (!j) { if (m.type !== 'progress') console.log('AI message for unknown job ' + m.id + ' ' + m.type); return; }
          if (m.type === 'region') j.region(m.a, m.b, m.data);
          else if (m.type === 'progress') j.progress(m.p);
          else if (m.type === 'done') j.done(m.ms);
          else if (m.type === 'error') j.fail(new Error(m.error));
        };
        w.onerror = (e) => { st.err = e.message || 'worker error'; res(false); };
        w.postMessage({ type: 'init', base: base(), manifest: st.manifest, cores: navigator.hardwareConcurrency || 4, isolated: self.crossOriginIsolated, prefer: (typeof PREF !== 'undefined' && PREF.aiDevice) || 'auto', runtime: st.manifest.runtime });
        if (native) setTimeout(() => { st.err = 'timed out after 180 s'; res(false); }, 180000);
      });
      if (!ok) { console.warn('AI stems unavailable' + (native ? ' (native)' : '') + ':', st.err); try { w.terminate ? w.terminate() : w.close(); } catch (e) { } st.worker = null; if (native) return false; }
      st.status = ok ? 'ready' : 'failed';
      bus.emit('ai');
      return ok;
    }
  }
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
  // separate an asset. onRegion(aSec, bSec, {vocals:[L,R], …}) streams 44.1 kHz pieces as they finish.
  function separate(A, { from = 0, onRegion, onProgress, overlap } = {}) {
    const id = ++st.seq, M = st.manifest, sr = M.sampleRate;
    let job;
    const promise = new Promise((resolve, reject) => {
      (async () => {
        const [L, R] = await toModelRate(A.buffer, sr);
        const len = L.length;
        const full = {}; for (const k of Object.values(KEYMAP)) full[k] = [new Float32Array(len), new Float32Array(len)];
        job = {
          region: (a, b, data) => {
            const parts = {};
            M.stems.forEach((name, s) => { const k = KEYMAP[name] || name; full[k][0].set(data[s * 2], a); full[k][1].set(data[s * 2 + 1], a); parts[k] = [full[k][0].subarray(a, b), full[k][1].subarray(a, b)]; });
            onRegion && onRegion(a / sr, b / sr, parts, sr);
          },
          progress: (p) => onProgress && onProgress(p),
          done: async (ms) => {
            st.jobs.delete(id);
            try {
              const out = {};
              for (const k in full) out[k] = await resampleTo(full[k], sr, A.buffer.sampleRate, A.buffer.length);
              resolve({ stems: out, ms });
            } catch (e) { reject(e); }
          },
          fail: (e) => { st.jobs.delete(id); reject(e); },
        };
        st.jobs.set(id, job);
        st.worker.postMessage({ type: 'separate', id, L, R, at: Math.round(from * sr), overlap: overlap ?? (typeof PREF !== 'undefined' && PREF.aiOverlap) ?? 0.25 }, st.native ? [] : [L.buffer, R.buffer]);   // the native bridge copies
      })().catch(reject);
    });
    return {
      promise,
      focus: (sec) => st.worker && st.worker.postMessage({ type: 'focus', id, at: Math.round(sec * sr) }),
      cancel: () => st.worker && st.worker.postMessage({ type: 'cancel', id }),
    };
  }
  function describe() {
    if (st.status === 'ready') return 'AI (HTDemucs) on ' + (st.ep === 'webgpu' ? 'the GPU (WebGPU)' : st.ep === 'dml' ? 'the GPU (DirectML)' : st.threads + ' CPU thread' + (st.threads > 1 ? 's' : '') + (st.native ? ' (native)' : ''));
    if (st.status === 'loading') return 'Starting the AI separator…';
    if (st.status === 'failed') return 'AI separator could not start (' + st.err + '): using the fast separator';
    return 'Fast separator (the AI model ships with the desktop app)';
  }
  return { probe, ready, separate, describe, get nativeErr() { return st.nativeErr || ''; }, get status() { return st.status; }, get ep() { return st.ep; }, get chunkMs() { return st.chunkMs; } };
})();
