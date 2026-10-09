# In-browser check of the AI separator (ONNX Runtime Web, multi-threaded WebAssembly) in headless Chromium.
import asyncio, subprocess, sys, os, time, json
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = """async (dbg) => {
  const src = document.getElementById('rush-ai-src').textContent;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const base = location.href.replace(/[^/]*$/, '');
  const manifest = await (await fetch('models/manifest.json')).json();
  const t0 = performance.now();
  const r = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => res({ type: 'failed', error: e.message });
    w.postMessage({ type: 'init', base, manifest, cores: navigator.hardwareConcurrency, isolated: self.crossOriginIsolated, prefer: 'cpu', debug: dbg }); });
  w.terminate();
  return Object.assign(r, { totalMs: Math.round(performance.now() - t0) });
}"""
async def main():
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'ci-serve.py'), '8766'])
    time.sleep(1.5)
    code = 0
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page()
            logs = []
            pg.on('console', lambda m: logs.append(m.type[:1] + ':' + m.text[:400]))
            pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)[:300]))
            await pg.goto('http://127.0.0.1:8766/RushMusicStudio.html')
            await pg.wait_for_function("document.querySelector('#statusMsg').textContent.startsWith('Ready')", timeout=60000)
            r = await pg.evaluate(PROBE, {})
            line = f"init: {r.get('type')} {r.get('ep','')} threads={r.get('threads','')} first window {round(r.get('chunkMs') or 0)} ms {r.get('error','')} | logs: {' / '.join(logs)[-600:]}"
            print(line); print('::notice title=AI variant::' + line)
            if r.get('type') == 'ready':
                r = await pg.evaluate("""(async()=>{
                  const ok = await AI.ready(); if (!ok) return { err: AI.describe() };
                  const dec = async (u) => Engine.ensure(false).decodeAudioData(await (await fetch(u)).arrayBuffer());
                  const mix = await dec('ci/mix.wav'), drums = await dec('ci/drums.wav'), bass = await dec('ci/bass.wav');
                  const A = addAsset('ci mix', mix, { bpm: 120, beats: 48 });
                  const t0 = performance.now(); await separateAsset(A); const ms = performance.now() - t0;
                  const sdr = (est, ref) => { let s = 0, e = 0; for (let c = 0; c < 2; c++) { const x = est.getChannelData(c), y = ref.getChannelData(c); for (let i = 0; i < y.length; i++) { s += y[i] * y[i]; e += (y[i] - x[i]) ** 2; } } return 10 * Math.log10(s / (e + 1e-12)); };
                  return { engine: A.stems.engine, ms, dur: mix.duration, drums: sdr(A.stems.buffers.drums, drums), bass: sdr(A.stems.buffers.bass, bass), desc: AI.describe() };
                })()""")
                msg = json.dumps(r) if 'err' in r else f"{r['desc']}: {r['dur']:.0f} s song separated in {r['ms']/1000:.1f} s ({r['dur']/(r['ms']/1000):.2f}x real-time), engine {r['engine']}, SDR drums {r['drums']:.1f} dB, bass {r['bass']:.1f} dB"
                print(msg); print('::notice title=AI stems in browser::' + msg)
            await b.close()
    finally:
        srv.terminate()
    return code
sys.exit(asyncio.run(main()))
