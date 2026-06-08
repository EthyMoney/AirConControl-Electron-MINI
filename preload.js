const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airconApi', {
  publishCommand(command) {
    return ipcRenderer.invoke('aircon:publish-command', command);
  },
  requestStatus() {
    return ipcRenderer.invoke('aircon:request-status');
  },
  getCoolingRuntimeReport() {
    return ipcRenderer.invoke('aircon:get-cooling-runtime-report');
  },
  getCoolingRuntimeHourlyReport() {
    return ipcRenderer.invoke('aircon:get-cooling-runtime-hourly-report');
  },
  onStatus(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('aircon:status', wrapped);
    return () => ipcRenderer.removeListener('aircon:status', wrapped);
  },
  onTempest(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('aircon:tempest', wrapped);
    return () => ipcRenderer.removeListener('aircon:tempest', wrapped);
  },
  onConnection(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('aircon:connection', wrapped);
    return () => ipcRenderer.removeListener('aircon:connection', wrapped);
  },
  onTempestStale(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('aircon:tempest-stale', wrapped);
    return () => ipcRenderer.removeListener('aircon:tempest-stale', wrapped);
  }
});