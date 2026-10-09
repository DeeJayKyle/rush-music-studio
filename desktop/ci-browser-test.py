# In-browser check of the AI separator (ONNX Runtime Web, multi-threaded WebAssembly) in headless Chromium.
import asyncio, subprocess, sys, os, time
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
async def main():
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'ci-serve.py'), '8766'])
    time.sleep(1.5)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            pg = await b.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            await pg.goto('http://127.0.0.1:8766/RushMusicStudio.html')
            await pg.wait_for_function("document.querySelector('#statusMsg').textContent.startsWith('Ready')", timeout=60000)
            ok = await pg.evaluate("AI.ready()")
            desc = await pg.evaluate("AI.describe()")
            if not ok:
                print('::error title=AI stems in browser::' + desc + ' ' + ' | '.join(errs)); return 1
            r = await pg.evaluate("""(async()=>{
              const dec = async (u) => Engine.ensure(false).decodeAudioData(await (await fetch(u)).arrayBuffer());
              const mix = await dec('ci/mix.wav'), drums = await dec('ci/drums.wav'), bass = await dec('ci/bass.wav');
              const A = addAsset('ci mix', mix, { bpm: 120, beats: 48 });
              const t0 = performance.now(); await separateAsset(A); const ms = performance.now() - t0;
              const sdr = (est, ref) => { let s = 0, e = 0; for (let c = 0; c < 2; c++) { const x = est.getChannelData(c), y = ref.getChannelData(c); for (let i = 0; i < y.length; i++) { s += y[i] * y[i]; e += (y[i] - x[i]) ** 2; } } return 10 * Math.log10(s / (e + 1e-12)); };
              return { engine: A.stems.engine, ms, dur: mix.duration, drums: sdr(A.stems.buffers.drums, drums), bass: sdr(A.stems.buffers.bass, bass), chunk: AI.chunkMs };
            })()""")
            msg = f"{desc}: {r['dur']:.0f} s song separated in {r['ms']/1000:.1f} s ({r['dur']/(r['ms']/1000):.2f}x real-time), engine {r['engine']}, SDR drums {r['drums']:.1f} dB, bass {r['bass']:.1f} dB"
            print(msg); print('::notice title=AI stems in browser::' + msg)
            if errs: print('::warning title=AI stems in browser::' + ' | '.join(errs)[:900])
            await b.close()
            return 0 if r['engine'] == 'ai' else 1
    finally:
        srv.terminate()
sys.exit(asyncio.run(main()))
