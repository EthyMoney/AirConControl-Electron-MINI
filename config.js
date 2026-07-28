const path = require('path');

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://192.168.1.216';
const MQTT_TOPIC_AIRCON = process.env.MQTT_TOPIC_AIRCON || 'home/shop/aircon';
const MQTT_TOPIC_AIRCON_COMMAND = process.env.MQTT_TOPIC_AIRCON_COMMAND || MQTT_TOPIC_AIRCON;
const MQTT_TOPIC_AIRCON_STATE = process.env.MQTT_TOPIC_AIRCON_STATE || MQTT_TOPIC_AIRCON;
const MQTT_TOPIC_TEMPEST_STATS = process.env.MQTT_TOPIC_TEMPEST_STATS || 'homeassistant/sensor/weatherflow2mqtt_ST-00095605/observation/state';
const MQTT_USERNAME = process.env.MQTT_USERNAME || null;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || null;

function getPositiveIntegerEnvironmentValue(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AIRCON_STALE_AFTER_MS = getPositiveIntegerEnvironmentValue('AIRCON_STALE_AFTER_MS', 300000);
const WEATHER_STALE_AFTER_MS = getPositiveIntegerEnvironmentValue('WEATHER_STALE_AFTER_MS', 900000);
const COMMAND_TIMEOUT_MS = getPositiveIntegerEnvironmentValue('COMMAND_TIMEOUT_MS', 10000);
const TEMPERATURE_HISTORY_SAMPLE_MS = getPositiveIntegerEnvironmentValue('TEMPERATURE_HISTORY_SAMPLE_MS', 300000);
const DETAILED_HISTORY_RETENTION_DAYS = getPositiveIntegerEnvironmentValue('DETAILED_HISTORY_RETENTION_DAYS', 90);

// How often to re-request a status once the air conditioner has gone quiet. Without this the
// display would poll exactly once on going stale and then wait for a full MQTT reconnect.
const AIRCON_STALE_RETRY_MS = getPositiveIntegerEnvironmentValue('AIRCON_STALE_RETRY_MS', 60000);

// The runtime store rewrites its whole file on every save, so saves are coalesced into a window
// rather than issued per status message. A crash can lose at most this much of the open interval.
const RUNTIME_SAVE_INTERVAL_MS = getPositiveIntegerEnvironmentValue('RUNTIME_SAVE_INTERVAL_MS', 30000);
// Cooling edges decide how runtime is attributed, so they are persisted promptly.
const RUNTIME_CRITICAL_SAVE_MS = getPositiveIntegerEnvironmentValue('RUNTIME_CRITICAL_SAVE_MS', 1000);
// Refreshing the .bak copy doubles the bytes written, so it happens on its own slower cadence.
const RUNTIME_BACKUP_INTERVAL_MS = getPositiveIntegerEnvironmentValue('RUNTIME_BACKUP_INTERVAL_MS', 3600000);

// The set-point range the hardware accepts. Shared by the renderer's clamp, the MQTT command
// validator, and the Home Assistant climate entity so the three can never disagree.
const MIN_SET_TEMPERATURE = 50;
const MAX_SET_TEMPERATURE = 90;

function getBooleanEnvironmentValue(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

// Desktop mode runs the app in a normal resizable window with a visible mouse cursor
// instead of the frameless, cursor-hidden kiosk layout used on the touchscreen.
function isDesktopModeEnabled() {
  if (process.argv.includes('--desktop')) {
    return true;
  }
  if (process.env.AIRCON_DESKTOP_MODE !== undefined) {
    return getBooleanEnvironmentValue('AIRCON_DESKTOP_MODE', false);
  }
  // Baked in at package time by the desktop build scripts via electron-builder extraMetadata.
  const packagedFlag = require('./package.json').airconDesktopMode;
  return packagedFlag === true || packagedFlag === 'true';
}

const DESKTOP_MODE = isDesktopModeEnabled();

// The Home Assistant bridge owns retained discovery, state, and availability topics, so exactly
// one instance should run it. The always-on wall display is that instance; desktop copies stay
// read-only unless HOME_ASSISTANT_DISCOVERY_ENABLED explicitly says otherwise.
const HOME_ASSISTANT_DISCOVERY_ENABLED = getBooleanEnvironmentValue(
  'HOME_ASSISTANT_DISCOVERY_ENABLED',
  !DESKTOP_MODE
);
const HOME_ASSISTANT_DISCOVERY_PREFIX = process.env.HOME_ASSISTANT_DISCOVERY_PREFIX || 'homeassistant';
const HOME_ASSISTANT_STATUS_TOPIC = process.env.HOME_ASSISTANT_STATUS_TOPIC || 'homeassistant/status';
const HOME_ASSISTANT_DEVICE_ID = process.env.HOME_ASSISTANT_DEVICE_ID || 'airconcontrol_shop';
const HOME_ASSISTANT_DEVICE_NAME = process.env.HOME_ASSISTANT_DEVICE_NAME || 'Shop Climate Control';
const HOME_ASSISTANT_BASE_TOPIC = process.env.HOME_ASSISTANT_BASE_TOPIC || 'airconcontrol/shop';
const HOME_ASSISTANT_STATE_INTERVAL_MS = getPositiveIntegerEnvironmentValue('HOME_ASSISTANT_STATE_INTERVAL_MS', 60000);
// Brokers evict the older session when a second client connects with the same id, so a desktop
// copy running alongside the wall display must not share its client id or the two would
// disconnect each other in a loop.
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID
  || `${HOME_ASSISTANT_DEVICE_ID}_bridge${DESKTOP_MODE ? '_desktop' : ''}`;

module.exports = {
  AIRCON_STALE_AFTER_MS,
  AIRCON_STALE_RETRY_MS,
  COMMAND_TIMEOUT_MS,
  DESKTOP_MODE,
  DETAILED_HISTORY_RETENTION_DAYS,
  MAX_SET_TEMPERATURE,
  MIN_SET_TEMPERATURE,
  RUNTIME_BACKUP_INTERVAL_MS,
  RUNTIME_CRITICAL_SAVE_MS,
  RUNTIME_SAVE_INTERVAL_MS,
  HOME_ASSISTANT_BASE_TOPIC,
  HOME_ASSISTANT_DEVICE_ID,
  HOME_ASSISTANT_DEVICE_NAME,
  HOME_ASSISTANT_DISCOVERY_ENABLED,
  HOME_ASSISTANT_DISCOVERY_PREFIX,
  HOME_ASSISTANT_STATUS_TOPIC,
  HOME_ASSISTANT_STATE_INTERVAL_MS,
  MQTT_BROKER_URL,
  MQTT_CLIENT_ID,
  MQTT_PASSWORD,
  MQTT_TOPIC_AIRCON,
  MQTT_TOPIC_AIRCON_COMMAND,
  MQTT_TOPIC_AIRCON_STATE,
  MQTT_TOPIC_TEMPEST_STATS,
  MQTT_USERNAME,
  TEMPERATURE_HISTORY_SAMPLE_MS,
  WEATHER_STALE_AFTER_MS,
  windowIcon: path.join(__dirname, 'snow.ico')
};
