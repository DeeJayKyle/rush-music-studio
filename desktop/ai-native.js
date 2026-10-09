// Native AI stem separator (Electron utility process): HTDemucs on ONNX Runtime for Node,
// using the GPU through DirectML on Windows and every CPU core elsewhere. Speaks the same
// message protocol as the in-page WebAssembly worker, so the app treats both the same.
const fs = require('fs'), path = require('path'), os = require('os');
const [appDir, aiDir] = process.argv.slice(2);
const core = new Function(fs.readFileSync(path.join(appDir, 'aiworker.js'), 'utf8') + '\nreturn { separateCore, HTD };')();
let ort = null, session = null, cfg = null, ep = '', threads = 1;
const jobs = new Map();

async function runChunk(x) {
  if (cfg.format === 'htdemucs-fwd') {
    const pre = core.HTD.htdemucsPreForward(x);
    const r = await session.run({ x: new ort.Tensor('float32', pre.spectrogram, core.HTD.SPECTROGRAM_SHAPE), xt: new ort.Tensor('float32', pre.waveform, core.HTD.WAVEFORM_SHAPE) });
    return core.HTD.htdemucsPostForward(r.x_out.data, r.xt_out.data, pre.spectrogramStats, pre.waveformStats);
  }
  const r = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 2, cfg.segment]) });
  return r[session.outputNames[0]].data;
}
async function init(m) {
  try { ort = require('onnxruntime-node'); } catch (e) { console.error('cannot load onnxruntime-node: ' + e.stack); throw e; }
  cfg = JSON.parse(fs.readFileSync(path.join(aiDir, 'models', 'manifest.json'), 'utf8'));
  threads = Math.max(1, Math.min(16, os.cpus().length));
  const tries = [];
  if (m.prefer !== 'cpu' && process.platform === 'win32') tries.push(['dml', 'dml']);
  tries.push(['cpu', 'cpu']);
  let last = null;
  for (const [name, provider] of tries) {
    try {
      console.log('creating session on ' + name);
      session = await ort.InferenceSession.create(path.join(aiDir, 'models', cfg.model), { executionProviders: [provider], intraOpNumThreads: threads, graphOptimizationLevel: 'all' });
      ep = name; console.log('session ready on ' + name);
      const t0 = Date.now();
      const y = await runChunk(new Float32Array(2 * cfg.segment).map((_, i) => Math.sin(i * 0.05) * 0.3));
      for (let i = 0; i < y.length; i += 997) if (!isFinite(y[i])) throw new Error('invalid output on ' + name);
      console.log('first window in ' + (Date.now() - t0) + ' ms');
      return { ep, threads, chunkMs: Date.now() - t0, native: true };
    } catch (e) { last = e; session = null; }
  }
  console.error('native AI failed: ' + (last && last.stack || last));
  throw last || new Error('ONNX Runtime could not start');
}
function serve(port) {
  const send = (msg) => port.postMessage(msg);
  port.on('message', async (ev) => {
    const m = ev.data;
    if (m && m.type !== 'focus') console.log('message ' + m.type);
    try {
      if (m.type === 'init') { const info = session ? { ep, threads, chunkMs: 0, native: true } : await init(m); send({ type: 'ready', ...info }); console.log('sent ready'); return; }
      if (m.type === 'focus') { const j = jobs.get(m.id); if (j) j.focus = m.at; return; }
      if (m.type === 'cancel') { const j = jobs.get(m.id); if (j) j.cancel = true; return; }
      if (m.type === 'separate') {
        const job = { focus: m.at || 0, cancel: false }; jobs.set(m.id, job);
        const t0 = Date.now();
        await core.separateCore({
          L: m.L, R: m.R, seg: cfg.segment, overlap: m.overlap ?? 0.25, nStems: cfg.stems.length, run: runChunk,
          focus: () => job.focus, cancelled: () => job.cancel,
          onRegion: (a, b, data) => send({ type: 'region', id: m.id, a, b, data }),
          onProgress: (p) => send({ type: 'progress', id: m.id, p }),
        });
        jobs.delete(m.id);
        send({ type: 'done', id: m.id, ms: Date.now() - t0 });
      }
    } catch (e) {
      if (m.id != null) jobs.delete(m.id);
      send({ type: m.type === 'init' ? 'failed' : 'error', id: m.id, error: String(e && e.message || e) });
    }
  });
  port.start();
}
process.parentPort.on('message', (e) => { if (e.data && e.data.type === 'port' && e.ports[0]) serve(e.ports[0]); });
