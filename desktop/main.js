// Rush Music Studio — desktop shell (Electron). Everything runs locally; no network access is used.
const { app, BrowserWindow, Menu, session } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d0f14', title: 'Rush Music Studio', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  // allow the microphone (recording) and your own folders/files (Explorer, Save As); block any outbound web request
  const allowed = ['media', 'audioCapture', 'fileSystem'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.includes(perm)));
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^https?:/i.test(d.url) }));
  win.loadFile(path.join(__dirname, 'app', 'RushMusicStudio.html'));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
