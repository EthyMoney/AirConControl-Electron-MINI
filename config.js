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

function getBooleanEnvironmentValue(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

const HOME_ASSISTANT_DISCOVERY_ENABLED = getBooleanEnvironmentValue('HOME_ASSISTANT_DISCOVERY_ENABLED', true);
const HOME_ASSISTANT_DISCOVERY_PREFIX = process.env.HOME_ASSISTANT_DISCOVERY_PREFIX || 'homeassistant';
const HOME_ASSISTANT_STATUS_TOPIC = process.env.HOME_ASSISTANT_STATUS_TOPIC || 'homeassistant/status';
const HOME_ASSISTANT_DEVICE_ID = process.env.HOME_ASSISTANT_DEVICE_ID || 'airconcontrol_shop';
const HOME_ASSISTANT_DEVICE_NAME = process.env.HOME_ASSISTANT_DEVICE_NAME || 'Shop Climate Control';
const HOME_ASSISTANT_BASE_TOPIC = process.env.HOME_ASSISTANT_BASE_TOPIC || 'airconcontrol/shop';
const HOME_ASSISTANT_STATE_INTERVAL_MS = getPositiveIntegerEnvironmentValue('HOME_ASSISTANT_STATE_INTERVAL_MS', 60000);
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || `${HOME_ASSISTANT_DEVICE_ID}_bridge`;

module.exports = {
  AIRCON_STALE_AFTER_MS,
  COMMAND_TIMEOUT_MS,
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
  WEATHER_STALE_AFTER_MS,
  windowIcon: path.join(__dirname, 'snow.ico')
};
