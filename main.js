const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { windowIcon } = require('./config');
const { MqttController } = require('./mqtt-controller');

let mainWindow;
const mqttController = new MqttController();

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

// Function to create the main window
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: width,
    height: height,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    icon: windowIcon,
    fullscreen: true, // Optional: Open the window in fullscreen mode
    frame: false // Optional: Remove window frame if desired (needs to be false to hide mouse cursor)
  });

  // Hide the menu bar
  mainWindow.setMenu(null);

  // Load the index.html file
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools (optional)
  //mainWindow.webContents.openDevTools();

  // Handle window close event
  mainWindow.on('closed', function () {
    mainWindow = null;
    app.quit();
  });
}

ipcMain.handle('aircon:publish-command', (_event, command) => {
  return mqttController.publish(command);
});

ipcMain.handle('aircon:request-status', () => {
  return mqttController.publish('status');
});

ipcMain.handle('aircon:get-cooling-runtime-report', () => {
  return mqttController.getCoolingRuntimeTotals();
});

ipcMain.handle('aircon:get-cooling-runtime-hourly-report', () => {
  return mqttController.getCoolingRuntimeHourlyReport();
});

mqttController.on('status', (payload) => {
  sendToRenderer('aircon:status', payload);
});

mqttController.on('tempest', (payload) => {
  sendToRenderer('aircon:tempest', payload);
});

mqttController.on('connection', (payload) => {
  sendToRenderer('aircon:connection', payload);
});

mqttController.on('tempest-stale', (payload) => {
  sendToRenderer('aircon:tempest-stale', payload);
});

// App ready event
app.whenReady().then(() => {
  mqttController.start();
  createWindow();

  // Additional setup code (if any)

  // macOS specific setup
  if (process.platform === 'darwin') {
    app.dock.hide(); // Hide the app icon in the dock
  }
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', function () {
  mqttController.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Activate the app (only on macOS)
app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
