const { EventEmitter } = require('events');
const fs = require('fs');
const mqtt = require('mqtt');
const path = require('path');
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
    this.previousTask = null;
    this.lastCoolingRuntimeMs = null;
    this.lastCoolingUpdateAt = null;
    this.coolingRuntimeTotalsPath = path.join(__dirname, 'cooling-runtime-daily.json');
    this.coolingRuntimeHourlyPath = path.join(__dirname, 'cooling-runtime-hourly.json');
    this.coolingRuntimeTotals = this.loadCoolingRuntimeTotals();
    this.coolingRuntimeHourly = this.loadCoolingRuntimeHourly();
  }

  normalizeTask(task) {
    const normalizedTask = String(task || '').trim().toLowerCase();

    if (normalizedTask === 'cool' || normalizedTask === 'cooling') {
      return 'cooling';
    }

    if (normalizedTask === 'heat' || normalizedTask === 'heating') {
      return 'heating';
    }

    if (normalizedTask === 'off') {
      return 'off';
    }

    return 'idle';
  }

  getDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  loadCoolingRuntimeTotals() {
    try {
      if (!fs.existsSync(this.coolingRuntimeTotalsPath)) {
        return {};
      }

      const content = fs.readFileSync(this.coolingRuntimeTotalsPath, 'utf8');
      const parsed = JSON.parse(content);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      return parsed;
    } catch (_error) {
      return {};
    }
  }

  saveCoolingRuntimeTotals() {
    const directory = path.dirname(this.coolingRuntimeTotalsPath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(this.coolingRuntimeTotalsPath, JSON.stringify(this.coolingRuntimeTotals, null, 2));
  }

  loadCoolingRuntimeHourly() {
    try {
      if (!fs.existsSync(this.coolingRuntimeHourlyPath)) {
        return {};
      }

      const content = fs.readFileSync(this.coolingRuntimeHourlyPath, 'utf8');
      const parsed = JSON.parse(content);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      return parsed;
    } catch (_error) {
      return {};
    }
  }

  saveCoolingRuntimeHourly() {
    const directory = path.dirname(this.coolingRuntimeHourlyPath);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(this.coolingRuntimeHourlyPath, JSON.stringify(this.coolingRuntimeHourly, null, 2));
  }

  addCoolingRuntimeDelta(runtimeMs, fromTimestampMs, toTimestampMs) {
    if (!Number.isFinite(runtimeMs) || runtimeMs <= 0) {
      return;
    }

    if (!Number.isFinite(fromTimestampMs) || !Number.isFinite(toTimestampMs) || toTimestampMs <= fromTimestampMs) {
      return;
    }

    const intervalMs = toTimestampMs - fromTimestampMs;
    let cursor = fromTimestampMs;
    let allocatedMs = 0;

    while (cursor < toTimestampMs) {
      const currentDate = new Date(cursor);
      const currentHour = currentDate.getHours();
      const dayKey = this.getDayKey(currentDate);

      const nextHourBoundary = new Date(cursor);
      nextHourBoundary.setMinutes(0, 0, 0);
      nextHourBoundary.setHours(nextHourBoundary.getHours() + 1);
      const sliceEnd = Math.min(toTimestampMs, nextHourBoundary.getTime());
      const sliceIntervalMs = sliceEnd - cursor;

      let sliceRuntimeMs = Math.floor((runtimeMs * sliceIntervalMs) / intervalMs);
      if (sliceEnd >= toTimestampMs) {
        sliceRuntimeMs = runtimeMs - allocatedMs;
      }

      if (sliceRuntimeMs > 0) {
        const dailyExisting = Number(this.coolingRuntimeTotals[dayKey] || 0);
        this.coolingRuntimeTotals[dayKey] = dailyExisting + sliceRuntimeMs;

        if (!this.coolingRuntimeHourly[dayKey] || typeof this.coolingRuntimeHourly[dayKey] !== 'object') {
          this.coolingRuntimeHourly[dayKey] = {};
        }

        const hourKey = String(currentHour);
        const hourlyExisting = Number(this.coolingRuntimeHourly[dayKey][hourKey] || 0);
        this.coolingRuntimeHourly[dayKey][hourKey] = hourlyExisting + sliceRuntimeMs;
      }

      allocatedMs += sliceRuntimeMs;
      cursor = sliceEnd;
    }

    this.saveCoolingRuntimeTotals();
    this.saveCoolingRuntimeHourly();
  }

  addCoolingRuntimeToToday(runtimeMs) {
    if (!Number.isFinite(runtimeMs) || runtimeMs <= 0) {
      return;
    }

    const dayKey = this.getDayKey();
    const existing = Number(this.coolingRuntimeTotals[dayKey] || 0);
    this.coolingRuntimeTotals[dayKey] = existing + Math.floor(runtimeMs);
    this.saveCoolingRuntimeTotals();
  }

  parseRuntimeStringToMilliseconds(value) {
    const trimmed = String(value || '').trim();

    if (!trimmed) {
      return null;
    }

    const hhmmssMatch = trimmed.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (hhmmssMatch) {
      const hours = Number.parseInt(hhmmssMatch[1], 10);
      const minutes = Number.parseInt(hhmmssMatch[2], 10);
      const seconds = hhmmssMatch[3] ? Number.parseInt(hhmmssMatch[3], 10) : 0;
      return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
    }

    return null;
  }

  parseGenericRuntimeNumberToMilliseconds(value) {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }

    // Unix timestamp in milliseconds.
    if (value >= 1e12) {
      return Math.max(0, Date.now() - value);
    }

    // Unix timestamp in seconds.
    if (value >= 1e9) {
      return Math.max(0, Date.now() - (value * 1000));
    }

    // Generic runtime values are treated as milliseconds.
    return value;
  }

  getRuntimeMilliseconds(payload) {
    const runtimeMsFields = ['RuntimeMilliseconds', 'runtimeMilliseconds', 'RuntimeMs', 'runtimeMs'];
    for (const key of runtimeMsFields) {
      const value = payload[key];
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
    }

    const runtimeSecondFields = ['RuntimeSeconds', 'runtimeSeconds', 'RuntimeSec', 'runtimeSec'];
    for (const key of runtimeSecondFields) {
      const value = payload[key];
      if (Number.isFinite(value) && value >= 0) {
        return value * 1000;
      }
    }

    const runtimeMinuteFields = ['RuntimeMinutes', 'runtimeMinutes', 'RuntimeMins', 'runtimeMins'];
    for (const key of runtimeMinuteFields) {
      const value = payload[key];
      if (Number.isFinite(value) && value >= 0) {
        return value * 60000;
      }
    }

    const genericRuntimeFields = ['Runtime', 'runtime', 'runTime'];
    for (const key of genericRuntimeFields) {
      const value = payload[key];

      if (Number.isFinite(value)) {
        return this.parseGenericRuntimeNumberToMilliseconds(value);
      }

      if (typeof value === 'string') {
        const numeric = Number.parseFloat(value);
        if (Number.isFinite(numeric)) {
          return this.parseGenericRuntimeNumberToMilliseconds(numeric);
        }

        const parsed = this.parseRuntimeStringToMilliseconds(value);
        if (parsed !== null) {
          return parsed;
        }
      }
    }

    return null;
  }

  updateCoolingRuntimeTotals(payload) {
    const task = this.normalizeTask(payload.Task);
    const runtimeMs = this.getRuntimeMilliseconds(payload);
    const now = Date.now();

    if (task === 'cooling') {
      if (Number.isFinite(runtimeMs)) {
        if (
          this.previousTask === 'cooling'
          && Number.isFinite(this.lastCoolingRuntimeMs)
          && Number.isFinite(this.lastCoolingUpdateAt)
        ) {
          const deltaRuntimeMs = runtimeMs - this.lastCoolingRuntimeMs;

          if (deltaRuntimeMs > 0) {
            this.addCoolingRuntimeDelta(deltaRuntimeMs, this.lastCoolingUpdateAt, now);
          }
        }

        this.lastCoolingRuntimeMs = runtimeMs;
        this.lastCoolingUpdateAt = now;
      }
    } else {
      this.lastCoolingRuntimeMs = null;
      this.lastCoolingUpdateAt = null;
    }

    this.previousTask = task;
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
      this.updateCoolingRuntimeTotals(payload);
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

  getCoolingRuntimeTotals() {
    this.coolingRuntimeTotals = this.loadCoolingRuntimeTotals();
    return { ...this.coolingRuntimeTotals };
  }

  getCoolingRuntimeHourlyReport() {
    this.coolingRuntimeHourly = this.loadCoolingRuntimeHourly();
    return { ...this.coolingRuntimeHourly };
  }
}

module.exports = {
  MqttController
};