// Rush Music Studio — desktop shell (Electron). Everything runs locally; no network access is used.
// The app is served from a private rush:// scheme with cross-origin isolation, which unlocks
// multi-threaded WebAssembly and WebGPU for the AI stem separator.
const { app, BrowserWindow, Menu, session, protocol, net, ipcMain, utilityProcess, MessageChannelMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([{ scheme: 'rush', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream' };
// app files live inside the package; the AI runtime and model ship as extra resources
const appDir = path.join(__dirname, 'app');
const aiDir = app.isPackaged ? path.join(process.resourcesPath, 'ai') : path.join(__dirname, 'ai');

function resolve(urlPath) {
  const p = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const [root, rel] = /^(models|ort)\//.test(p) ? [aiDir, p] : [appDir, p || 'RushMusicStudio.html'];
  const file = path.normalize(path.join(root, rel));
  return file.startsWith(root + path.sep) ? file : null;     // no escaping the app folders
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d0f14', title: 'Rush Music Studio', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.js') },
  });
  Menu.setApplicationMenu(null);
  win.loadURL('rush://app/RushMusicStudio.html');
  // CI self-test: report whether the packaged app can start the AI separator, then quit
  if (process.env.RUSH_SELFTEST) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => {
          for (let i = 0; i < 120 && !/^Ready/.test((document.querySelector('#statusMsg') || {}).textContent || ''); i++) await new Promise((r) => setTimeout(r, 500));
          const ok = await AI.ready();
          let sep = null;
          if (ok) {
            const sr = 44100, n = sr * 20, L = new Float32Array(n), R = new Float32Array(n);
            for (let i = 0; i < n; i++) { const t = i / sr; L[i] = 0.3 * Math.sin(2 * Math.PI * 110 * t) + (Math.random() - 0.5) * 0.2 * Math.exp(-((t * 2) % 1) * 20); R[i] = L[i]; }
            const A = addAsset('selftest', makeBuffer([L, R], sr), { bpm: 120, beats: 40 });
            const t0 = performance.now(); await separateAsset(A); sep = { engine: A.stems.engine, seconds: +((performance.now() - t0) / 1000).toFixed(1), realtime: +(20 / ((performance.now() - t0) / 1000)).toFixed(2) };
          }
          return JSON.stringify({ ok, desc: AI.describe(), nativeErr: AI.nativeErr, desktop: !!window.rushDesktop, isolated: self.crossOriginIsolated, chunkMs: Math.round(AI.chunkMs), sep });
        })()`);
        console.log('RUSH_SELFTEST ' + r);
      } catch (e) { console.log('RUSH_SELFTEST error ' + e.message); }
      app.exit(0);
    });
  }
}

app.whenReady().then(() => {
  protocol.handle('rush', async (req) => {
    const file = resolve(new URL(req.url).pathname);
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const h = new Headers();
    h.set('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    const len = res.headers.get('content-length'); if (len) h.set('Content-Length', len);
    return new Response(res.body, { status: 200, headers: h });
  });
  // allow the microphone (recording) and your own folders/files (Explorer, Save As); block any outbound web request
  const allowed = ['media', 'audioCapture', 'fileSystem'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.includes(perm)));
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^https?:/i.test(d.url) }));
  // native AI separator in its own process; each page gets a private message channel to it
  let aiProc = null;
  ipcMain.on('rush-ai-port', (e) => {
    if (!fs.existsSync(path.join(aiDir, 'models', 'manifest.json'))) return;
    if (!aiProc) {
      aiProc = utilityProcess.fork(path.join(__dirname, 'ai-native.js'), [appDir, aiDir], { serviceName: 'Rush AI stem separator', stdio: 'pipe' });
      for (const s of [aiProc.stdout, aiProc.stderr]) if (s) s.on('data', (d) => console.log('RUSH_AI_LOG ' + String(d).trim().slice(0, 500)));
      aiProc.on('exit', () => { aiProc = null; });
    }
    const { port1, port2 } = new MessageChannelMain();
    aiProc.postMessage({ type: 'port' }, [port1]);
    e.sender.postMessage('rush-ai-port', null, [port2]);
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
