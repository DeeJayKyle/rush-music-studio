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
            variants = [('verbose', {'logLevel': 'verbose', 'debug': True, 'threads': 1}),
                        ('app defaults', {}),
                        ('no arena', {'session': {'enableCpuMemArena': False, 'enableMemPattern': False}}),
                        ('no arena, basic opt', {'session': {'enableCpuMemArena': False, 'enableMemPattern': False, 'graphOptimizationLevel': 'basic'}}),
                        ('1 thread, no arena', {'threads': 1, 'session': {'enableCpuMemArena': False, 'enableMemPattern': False}}),
                        ('plain wasm runtime', {'session': {'enableCpuMemArena': False, 'enableMemPattern': False}, 'runtime': 'ort.min.js'})]
            if os.path.exists(os.path.join(HERE, 'ai', 'models', 'htdemucs32.onnx')):
                variants.append(('fp32 model, no arena', {'model': 'htdemucs32.onnx', 'session': {'enableCpuMemArena': False, 'enableMemPattern': False}}))
            for name, dbg in variants:
                logs.clear()
                r = await pg.evaluate(PROBE, dbg)
                line = f"{name}: {r.get('type')} {r.get('ep','')} threads={r.get('threads','')} chunk={round(r.get('chunkMs') or 0)}ms total={r['totalMs']}ms {r.get('error','')} | logs: {' / '.join(l for l in logs if 'Rush' not in l)[-1800:]}"
                print(line); print('::notice title=AI variant::' + line)
            await b.close()
    finally:
        srv.terminate()
    return code
sys.exit(asyncio.run(main()))
