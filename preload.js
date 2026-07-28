const { contextBridge, ipcRenderer } = require('electron');

// The main process passes these through webPreferences.additionalArguments so the renderer
// clamps against the same set-point range the command validator enforces.
function readNumericArgument(name, fallback) {
  const argument = process.argv.find((value) => value.startsWith(`--${name}=`));
  const parsed = Number.parseInt(argument?.slice(name.length + 3), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

contextBridge.exposeInMainWorld('airconApi', {
  desktopMode: process.argv.includes('--desktop'),
  setTemperatureRange: {
    min: readNumericArgument('set-temp-min', 50),
    max: readNumericArgument('set-temp-max', 90)
  },
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
