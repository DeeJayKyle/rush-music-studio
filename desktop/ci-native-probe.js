// CI: time one HTDemucs window with the onnxruntime-node copy packaged in the app, run by the Electron binary as Node.
const path = require('path'), fs = require('fs');
const [res] = process.argv.slice(2);
const ort = require(path.join(res, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node'));
const core = new Function(fs.readFileSync(path.join(__dirname, '..', 'src', 'aiworker.js'), 'utf8') + '\nreturn { HTD };')();
const cfg = JSON.parse(fs.readFileSync(path.join(res, 'ai', 'models', 'manifest.json'), 'utf8'));
(async () => {
  for (const [name, opts] of [['defaults', {}], ['app options', { executionProviders: ['cpu'], intraOpNumThreads: require('os').cpus().length, graphOptimizationLevel: 'all' }]]) {
    const t0 = Date.now();
    const s = await ort.InferenceSession.create(path.join(res, 'ai', 'models', cfg.model), opts);
    const t1 = Date.now();
    const pre = core.HTD.htdemucsPreForward(new Float32Array(2 * cfg.segment).map((_, i) => Math.sin(i * 0.05) * 0.3));
    const r = await s.run({ x: new ort.Tensor('float32', pre.spectrogram, core.HTD.SPECTROGRAM_SHAPE), xt: new ort.Tensor('float32', pre.waveform, core.HTD.WAVEFORM_SHAPE) });
    console.log(`PROBE ${name}: load ${t1 - t0} ms, window ${Date.now() - t1} ms, out ${r.x_out.dims}`);
  }
  process.exit(0);
})().catch((e) => { console.log('PROBE error ' + e.stack); process.exit(1); });
