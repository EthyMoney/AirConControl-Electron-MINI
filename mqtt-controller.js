const { EventEmitter } = require('events');
const mqtt = require('mqtt');
const {
  MQTT_BROKER_URL,
  MQTT_TOPIC_AIRCON,
  MQTT_TOPIC_TEMPEST_STATS
} = require('./config');

class MqttController extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.lastStatusMessageTime = 0;
    this.lastTempestStatsMessageTime = 0;
    this.statusWatchdog = null;
    this.tempestWatchdog = null;
  }

  start() {
    if (this.client) {
      return;
    }

    this.lastStatusMessageTime = Date.now();
    this.lastTempestStatsMessageTime = Date.now();

    this.client = mqtt.connect(MQTT_BROKER_URL, {
      reconnectPeriod: 5000
    });

    this.client.on('connect', () => {
      this.emit('connection', { state: 'connected' });
      this.client.subscribe([MQTT_TOPIC_AIRCON, MQTT_TOPIC_TEMPEST_STATS], (error) => {
        if (error) {
          this.emit('connection', { state: 'error', message: error.message });
          return;
        }

        this.requestStatus();
      });
    });

    this.client.on('reconnect', () => {
      this.emit('connection', { state: 'reconnecting' });
    });

    this.client.on('offline', () => {
      this.emit('connection', { state: 'offline' });
    });

    this.client.on('close', () => {
      this.emit('connection', { state: 'closed' });
    });

    this.client.on('error', (error) => {
      this.emit('connection', { state: 'error', message: error.message });
    });

    this.client.on('message', (topic, messageBuffer) => {
      const message = messageBuffer.toString();
      if (topic === MQTT_TOPIC_AIRCON) {
        this.handleAirconMessage(message);
        return;
      }

      if (topic === MQTT_TOPIC_TEMPEST_STATS) {
        this.handleTempestMessage(message);
      }
    });

    this.statusWatchdog = setInterval(() => {
      if (Date.now() - this.lastStatusMessageTime >= 300000) {
        this.emit('connection', { state: 'stale-status' });
        this.requestStatus();
      }
    }, 300000);

    this.tempestWatchdog = setInterval(() => {
      if (Date.now() - this.lastTempestStatsMessageTime >= 900000) {
        this.emit('tempest-stale', true);
      }
    }, 900000);
  }

  stop() {
    if (this.statusWatchdog) {
      clearInterval(this.statusWatchdog);
      this.statusWatchdog = null;
    }

    if (this.tempestWatchdog) {
      clearInterval(this.tempestWatchdog);
      this.tempestWatchdog = null;
    }

    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
  }

  requestStatus() {
    this.publish('status');
  }

  publish(message) {
    if (!this.client || !this.client.connected) {
      return false;
    }

    this.client.publish(MQTT_TOPIC_AIRCON, message);
    return true;
  }

  handleAirconMessage(message) {
    if (message === 'status' || message === 'on' || message === 'off' || message.startsWith('set-')) {
      return;
    }

    try {
      const payload = JSON.parse(message);
      this.lastStatusMessageTime = Date.now();
      this.emit('status', payload);
    } catch (error) {
      this.emit('connection', { state: 'error', message: `Failed to parse aircon payload: ${error.message}` });
    }
  }

  handleTempestMessage(message) {
    try {
      const payload = JSON.parse(message);
      this.lastTempestStatsMessageTime = Date.now();
      this.emit('tempest-stale', false);
      this.emit('tempest', payload);
    } catch (error) {
      this.emit('connection', { state: 'error', message: `Failed to parse weather payload: ${error.message}` });
    }
  }
}

module.exports = {
  MqttController
};