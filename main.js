const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { randomUUID } = require('crypto');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const packageMetadata = require('./package.json');
const {
  AIRCON_INSTANCE_ID,
  DESKTOP_MODE,
  HOME_ASSISTANT_BASE_TOPIC,
  HOME_ASSISTANT_DISCOVERY_ENABLED,
  HOME_ASSISTANT_LEASE_DURATION_MS,
  HOME_ASSISTANT_LEASE_TOPIC,
  MAX_SET_TEMPERATURE,
  MIN_SET_TEMPERATURE,
  MQTT_BROKER_URL,
  MQTT_CLIENT_ID,
  MQTT_CONNECT_OPTIONS,
  MQTT_PASSWORD,
  MQTT_USERNAME,
  windowIcon
} = require('./config');
const { HomeAssistantLease } = require('./home-assistant-lease');
const { MqttController } = require('./mqtt-controller');
const { isRaspberryPi, requestSystemPower } = require('./system-power');

let mainWindow = null;
let mqttController = null;
let homeAssistantLease = null;
let shutdownStarted = false;
let shutdownComplete = false;
let systemPowerRequested = false;
const raspberryPi = isRaspberryPi();

// Process supervisors stop services with SIGTERM. Route that through Electron's normal
// quit lifecycle so MQTT presence, lease ownership, and runtime history are flushed first.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`Received ${signal}; shutting down AirConControl cleanly.`);
    app.quit();
  });
}

function getInstanceSuffix() {
  return `${AIRCON_INSTANCE_ID}_${process.pid}`;
}

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
      additionalArguments: [
        ...(DESKTOP_MODE ? ['--desktop'] : []),
        ...(raspberryPi ? ['--raspberry-pi'] : []),
        `--set-temp-min=${MIN_SET_TEMPERATURE}`,
        `--set-temp-max=${MAX_SET_TEMPERATURE}`
      ],
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
ipcMain.handle('system:power', async (_event, action) => {
  if (!raspberryPi) {
    return { ok: false, error: 'System power controls are only available on a Raspberry Pi' };
  }
  if (systemPowerRequested) {
    return { ok: false, error: 'A system power action is already in progress' };
  }

  systemPowerRequested = true;
  try {
    await requireController().flushRuntimeState();
    await requestSystemPower(action);
    return { ok: true };
  } catch (error) {
    systemPowerRequested = false;
    console.error(`Failed to perform system power action '${action}':`, error);
    return { ok: false, error: error.message };
  }
});

app.whenReady().then(async () => {
  const runtimeDataPath = path.join(app.getPath('userData'), 'cooling-runtime-report.json');
  const instanceSuffix = getInstanceSuffix();

  mqttController = new MqttController({
    runtimeDataPath,
    legacyDailyPath: path.join(__dirname, 'cooling-runtime-daily.json'),
    legacyHourlyPath: path.join(__dirname, 'cooling-runtime-hourly.json'),
    mqttClientId: `${MQTT_CLIENT_ID}_${instanceSuffix}`,
    instanceId: AIRCON_INSTANCE_ID,
    hostname: os.hostname(),
    version: packageMetadata.version,
    homeAssistantConfigured: HOME_ASSISTANT_DISCOVERY_ENABLED,
    homeAssistantEnabled: false
  });
  await mqttController.initialize();
  mqttController.on('state', (snapshot) => {
    sendToRenderer('aircon:state', snapshot);
    if (!shutdownStarted) {
      homeAssistantLease?.setEligible(snapshot.mqtt.status === 'connected')
        .catch((error) => console.error('Failed to update Home Assistant bridge eligibility:', error));
    }
  });

  createWindow();
  mqttController.start();

  if (HOME_ASSISTANT_DISCOVERY_ENABLED) {
    const bridgeSessionId = randomUUID();
    let lastLeaseError = null;
    homeAssistantLease = new HomeAssistantLease({
      brokerUrl: MQTT_BROKER_URL,
      clientId: `${MQTT_CLIENT_ID}_${instanceSuffix}_${bridgeSessionId}_lease`,
      ownerId: `${instanceSuffix}_${bridgeSessionId}`,
      instanceId: AIRCON_INSTANCE_ID,
      hostname: os.hostname(),
      version: packageMetadata.version,
      topic: HOME_ASSISTANT_LEASE_TOPIC,
      availabilityTopic: `${HOME_ASSISTANT_BASE_TOPIC}/availability`,
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,
      mqttConnectOptions: MQTT_CONNECT_OPTIONS,
      eligible: mqttController.getSnapshot().mqtt.status === 'connected',
      leaseDurationMs: HOME_ASSISTANT_LEASE_DURATION_MS
    });
    homeAssistantLease.on('state', (state) => {
      mqttController.setHomeAssistantLeaseState(state);
      if (state.error && state.error !== lastLeaseError) {
        console.error(`Home Assistant lease ${state.role}: ${state.error}`);
      } else if (!state.error && lastLeaseError) {
        console.log(`Home Assistant lease recovered as ${state.role}.`);
      }
      lastLeaseError = state.error;
    });
    homeAssistantLease.on('acquired', () => {
      mqttController.setHomeAssistantEnabled(true)
        .catch(async (error) => {
          console.error('Failed to enable Home Assistant bridge:', error);
          await homeAssistantLease.yieldLeadership(`Bridge setup failed: ${error.message}`);
        })
        .catch((error) => console.error('Failed to yield Home Assistant bridge lease:', error));
    });
    homeAssistantLease.on('lost', () => {
      mqttController.setHomeAssistantEnabled(false)
        .catch((error) => console.error('Failed to disable Home Assistant bridge:', error));
    });
    homeAssistantLease.start();
  }

  if (process.platform === 'darwin' && !DESKTOP_MODE) {
    app.dock.hide();
  }
}).catch(async (error) => {
  console.error('Failed to start AirConControl:', error);
  await homeAssistantLease?.stop();
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
    .then(() => homeAssistantLease?.stop())
    .catch((error) => console.error('Failed to release Home Assistant bridge lease:', error))
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
