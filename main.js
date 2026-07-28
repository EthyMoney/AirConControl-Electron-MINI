const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { DESKTOP_MODE, windowIcon } = require('./config');
const { MqttController } = require('./mqtt-controller');

let mainWindow = null;
let mqttController = null;
let shutdownStarted = false;
let shutdownComplete = false;

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const indexPath = path.join(__dirname, 'index.html');
  const allowedUrl = pathToFileURL(indexPath).toString();
  // The UI is laid out for an 800x480 touchscreen, so the desktop window matches that
  // content size rather than filling the display.
  mainWindow = new BrowserWindow({
    width: DESKTOP_MODE ? Math.min(width, 800) : width,
    height: DESKTOP_MODE ? Math.min(height, 480) : height,
    minWidth: DESKTOP_MODE ? 640 : undefined,
    minHeight: DESKTOP_MODE ? 400 : undefined,
    useContentSize: DESKTOP_MODE,
    center: DESKTOP_MODE,
    title: 'AirConControl',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: DESKTOP_MODE ? ['--desktop'] : [],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    },
    icon: windowIcon,
    fullscreen: !DESKTOP_MODE,
    frame: DESKTOP_MODE,
    resizable: DESKTOP_MODE
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== allowedUrl) {
      event.preventDefault();
    }
  });
  mainWindow.loadFile(indexPath);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function requireController() {
  if (!mqttController) {
    throw new Error('The controller is still starting');
  }
  return mqttController;
}

ipcMain.handle('aircon:get-state', () => requireController().getSnapshot());
ipcMain.handle('aircon:send-command', (_event, command) => requireController().sendCommand(command));
ipcMain.handle('aircon:request-status', () => requireController().requestStatus());
ipcMain.handle('aircon:get-runtime-report', () => requireController().getRuntimeReport());

app.whenReady().then(async () => {
  const runtimeDataPath = path.join(app.getPath('userData'), 'cooling-runtime-report.json');
  mqttController = new MqttController({
    runtimeDataPath,
    legacyDailyPath: path.join(__dirname, 'cooling-runtime-daily.json'),
    legacyHourlyPath: path.join(__dirname, 'cooling-runtime-hourly.json')
  });
  await mqttController.initialize();
  mqttController.on('state', (snapshot) => sendToRenderer('aircon:state', snapshot));

  createWindow();
  mqttController.start();

  if (process.platform === 'darwin' && !DESKTOP_MODE) {
    app.dock.hide();
  }
}).catch((error) => {
  console.error('Failed to start AirConControl:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', (event) => {
  if (shutdownComplete || !mqttController) {
    return;
  }

  event.preventDefault();
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  mqttController.stop()
    .catch((error) => console.error('Failed to flush runtime state:', error))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
