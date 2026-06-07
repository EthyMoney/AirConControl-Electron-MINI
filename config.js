const path = require('path');

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://192.168.1.216';
const MQTT_TOPIC_AIRCON = process.env.MQTT_TOPIC_AIRCON || 'home/shop/aircon';
const MQTT_TOPIC_TEMPEST_STATS = process.env.MQTT_TOPIC_TEMPEST_STATS || 'homeassistant/sensor/weatherflow2mqtt_ST-00095605/observation/state';

module.exports = {
  MQTT_BROKER_URL,
  MQTT_TOPIC_AIRCON,
  MQTT_TOPIC_TEMPEST_STATS,
  windowIcon: path.join(__dirname, 'snow.ico')
};