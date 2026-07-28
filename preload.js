const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airconApi', {
  desktopMode: process.argv.includes('--desktop'),
  getState() {
    return ipcRenderer.invoke('aircon:get-state');
  },
  sendCommand(command) {
    return ipcRenderer.invoke('aircon:send-command', command);
  },
  requestStatus() {
    return ipcRenderer.invoke('aircon:request-status');
  },
  getRuntimeReport() {
    return ipcRenderer.invoke('aircon:get-runtime-report');
  },
  onState(listener) {
    const wrapped = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('aircon:state', wrapped);
    return () => ipcRenderer.removeListener('aircon:state', wrapped);
  }
});
