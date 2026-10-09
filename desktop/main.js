// Rush Music Studio — desktop shell (Electron). Everything runs locally; no network access is used.
// The app is served from a private rush:// scheme with cross-origin isolation, which unlocks
// multi-threaded WebAssembly and WebGPU for the AI stem separator.
const { app, BrowserWindow, Menu, session, protocol, net } = require('electron');
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
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
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
          return JSON.stringify({ ok, desc: AI.describe(), isolated: self.crossOriginIsolated, chunkMs: Math.round(AI.chunkMs) });
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
  createWindow();
});
app.on('window-all-closed', () => app.quit());
