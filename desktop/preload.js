// Gives the page a private channel to the native AI separator (runs in its own process).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rushDesktop', { native: true, requestAIPort: () => ipcRenderer.send('rush-ai-port') });
ipcRenderer.on('rush-ai-port', (e) => window.postMessage({ rushAIPort: true }, '*', e.ports));
