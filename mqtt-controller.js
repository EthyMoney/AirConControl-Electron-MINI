const { EventEmitter } = require('events');
const mqtt = require('mqtt');
const { HomeAssistantBridge } = require('./home-assistant-bridge');
const { RuntimeStore } = require('./runtime-store');
const {
  AIRCON_STALE_AFTER_MS,
  COMMAND_TIMEOUT_MS,
  DETAILED_HISTORY_RETENTION_DAYS,
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
  MQTT_TOPIC_AIRCON_COMMAND,
  MQTT_TOPIC_AIRCON_STATE,
  MQTT_TOPIC_TEMPEST_STATS,
  MQTT_USERNAME,
  TEMPERATURE_HISTORY_SAMPLE_MS,
  WEATHER_STALE_AFTER_MS
} = require('./config');

const COMMAND_PATTERN = /^(on|off|set-(\d{2}))$/;
const TASK_ALIASES = new Map([
  ['cool', 'cooling'],
  ['cooling', 'cooling'],
  ['heat', 'heating'],
  ['heating', 'heating'],
  ['off', 'off'],
  ['idle', 'idle'],
  ['standby', 'idle'],
  ['fault', 'fault'],
  ['error', 'fault']
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTask(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return 'unknown';
  }
  return TASK_ALIASES.get(String(value).trim().toLowerCase()) || 'unknown';
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 1 || value === 0) {
    return value === 1;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['on', 'true', '1', 'running', 'active', 'enabled'].includes(normalized)) {
      return true;
    }
    if (['off', 'false', '0', 'idle', 'inactive', 'disabled'].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function normalizeNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
}

function findFirstValue(payload, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return { found: true, key, value: payload[key] };
    }
  }
  return { found: false, key: null, value: undefined };
}

function findBooleanState(payload, keys, keyword) {
  const explicit = findFirstValue(payload, keys);
  if (explicit.found) {
    return normalizeBoolean(explicit.value);
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key.toLowerCase().includes(keyword)) {
      const normalized = normalizeBoolean(value);
      if (normalized !== null) {
        return normalized;
      }
    }
  }
  return null;
}

function parseDurationStringToMilliseconds(value) {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  const clockMatch = trimmed.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clockMatch) {
    const hours = Number.parseInt(clockMatch[1], 10);
    const minutes = Number.parseInt(clockMatch[2], 10);
    const seconds = clockMatch[3] ? Number.parseInt(clockMatch[3], 10) : 0;
    if (minutes >= 60 || seconds >= 60) {
      return null;
    }
    return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
  }

  const unitsMatch = trimmed.match(/^\s*(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes))?\s*(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds))?\s*$/i);
  if (unitsMatch && (unitsMatch[1] || unitsMatch[2] || unitsMatch[3])) {
    const hours = Number(unitsMatch[1] || 0);
    const minutes = Number(unitsMatch[2] || 0);
    const seconds = Number(unitsMatch[3] || 0);
    return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
  }

  return null;
}

function parseRuntime(payload, now = Date.now()) {
  const unitFields = [
    { keys: ['RuntimeMilliseconds', 'runtimeMilliseconds', 'RuntimeMs', 'runtimeMs'], multiplier: 1 },
    { keys: ['RuntimeSeconds', 'runtimeSeconds', 'RuntimeSec', 'runtimeSec'], multiplier: 1000 },
    { keys: ['RuntimeMinutes', 'runtimeMinutes', 'RuntimeMins', 'runtimeMins'], multiplier: 60000 }
  ];

  for (const field of unitFields) {
    const candidate = findFirstValue(payload, field.keys);
    if (!candidate.found) {
      continue;
    }
    const numeric = normalizeNumber(candidate.value);
    return numeric !== null && numeric >= 0
      ? { milliseconds: numeric * field.multiplier, source: candidate.key }
      : null;
  }

  const startedAt = findFirstValue(payload, ['RuntimeStartedAt', 'runtimeStartedAt', 'StateSince', 'stateSince']);
  if (startedAt.found) {
    const numeric = normalizeNumber(startedAt.value);
    if (numeric !== null) {
      const timestampMs = numeric >= 1e12 ? numeric : numeric * 1000;
      return timestampMs <= now ? { milliseconds: now - timestampMs, source: startedAt.key } : null;
    }
    const timestampMs = Date.parse(startedAt.value);
    return Number.isFinite(timestampMs) && timestampMs <= now
      ? { milliseconds: now - timestampMs, source: startedAt.key }
      : null;
  }

  const generic = findFirstValue(payload, ['Runtime', 'runtime', 'runTime']);
  if (!generic.found) {
    return null;
  }
  if (typeof generic.value === 'string') {
    const durationMs = parseDurationStringToMilliseconds(generic.value);
    if (durationMs !== null) {
      return { milliseconds: durationMs, source: generic.key };
    }
  }
  const numeric = normalizeNumber(generic.value);
  return numeric !== null && numeric >= 0
    ? { milliseconds: numeric, source: generic.key }
    : null;
}

function normalizeAirconPayload(payload, previousReported = null, now = Date.now()) {
  if (!isRecord(payload)) {
    throw new Error('Air-conditioner status must be a JSON object');
  }

  const coreKeys = ['Task', 'task', 'Enabled', 'enabled', 'Temp', 'temp', 'SetTemp', 'setTemp'];
  if (!coreKeys.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('Air-conditioner status is missing Task, Enabled, Temp, and SetTemp');
  }

  const previous = previousReported || {};
  const taskValue = findFirstValue(payload, ['Task', 'task']);
  const enabledValue = findFirstValue(payload, ['Enabled', 'enabled']);
  const tempValue = findFirstValue(payload, ['Temp', 'temp']);
  const setTempValue = findFirstValue(payload, ['SetTemp', 'setTemp']);
  const fanOn = findBooleanState(payload, ['Fan', 'fan', 'FanOn', 'fanOn', 'FanON', 'Blower', 'blower'], 'fan');
  const compressorOn = findBooleanState(payload, ['Compressor', 'compressor', 'CompressorOn', 'compressorOn', 'CompON', 'compON', 'CompOn', 'compOn'], 'compressor');

  const normalized = {
    enabled: enabledValue.found ? normalizeBoolean(enabledValue.value) : (previous.enabled ?? null),
    task: taskValue.found ? normalizeTask(taskValue.value) : (previous.task || 'unknown'),
    taskRaw: taskValue.found ? String(taskValue.value) : (previous.taskRaw || null),
    temp: tempValue.found ? normalizeNumber(tempValue.value) : (previous.temp ?? null),
    setTemp: setTempValue.found ? normalizeNumber(setTempValue.value) : (previous.setTemp ?? null),
    fanOn: fanOn ?? previous.fanOn ?? null,
    compressorOn: compressorOn ?? previous.compressorOn ?? null,
    runtimeMs: previous.runtimeMs ?? null,
    runtimeSource: previous.runtimeSource ?? null,
    runtimeObservedAt: previous.runtimeObservedAt ?? null
  };

  for (const [fieldName, field] of [['Enabled', enabledValue], ['Temp', tempValue], ['SetTemp', setTempValue]]) {
    if (field.found && (fieldName === 'Enabled' ? normalizeBoolean(field.value) : normalizeNumber(field.value)) === null) {
      throw new Error(`${fieldName} has an invalid value`);
    }
  }

  const runtime = parseRuntime(payload, now);
  const runtimeKeys = [
    'RuntimeMilliseconds', 'runtimeMilliseconds', 'RuntimeMs', 'runtimeMs',
    'RuntimeSeconds', 'runtimeSeconds', 'RuntimeSec', 'runtimeSec',
    'RuntimeMinutes', 'runtimeMinutes', 'RuntimeMins', 'runtimeMins',
    'RuntimeStartedAt', 'runtimeStartedAt', 'StateSince', 'stateSince',
    'Runtime', 'runtime', 'runTime'
  ];
  if (!runtime && runtimeKeys.some((key) => Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('Runtime has an invalid value or format');
  }
  if (runtime) {
    normalized.runtimeMs = runtime.milliseconds;
    normalized.runtimeSource = runtime.source;
    normalized.runtimeObservedAt = now;
  }

  return normalized;
}

function normalizeWeatherPayload(payload) {
  if (!isRecord(payload)) {
    throw new Error('Weather status must be a JSON object');
  }

  const temperature = normalizeNumber(payload.air_temperature);
  const humidity = normalizeNumber(payload.relative_humidity);
  if (temperature === null || humidity === null || humidity < 0 || humidity > 100) {
    throw new Error('Weather status requires numeric air_temperature and relative_humidity');
  }

  return { temperature, humidity };
}

function parseCommand(command) {
  if (typeof command !== 'string') {
    return null;
  }
  const match = command.match(COMMAND_PATTERN);
  if (!match) {
    return null;
  }
  if (match[1].startsWith('set-')) {
    const setTemp = Number.parseInt(match[2], 10);
    if (setTemp < 50 || setTemp > 90) {
      return null;
    }
    return { raw: command, type: 'set-temperature', desired: { setTemp } };
  }
  return { raw: command, type: 'power', desired: { enabled: match[1] === 'on' } };
}

function commandMatchesReported(command, reported) {
  if (!command || !reported) {
    return false;
  }
  if (command.type === 'set-temperature') {
    return reported.setTemp === command.desired.setTemp;
  }
  if (command.desired.enabled) {
    return reported.enabled === null
      ? ['idle', 'cooling', 'heating'].includes(reported.task)
      : reported.enabled === true;
  }
  return reported.enabled === null ? reported.task === 'off' : reported.enabled === false;
}

function createInitialState(now, homeAssistantBridge) {
  return {
    revision: 0,
    updatedAt: now,
    mqtt: { status: 'disconnected', changedAt: now, error: null },
    aircon: { reported: null, receivedAt: null, freshness: 'unknown', freshnessChangedAt: now, error: null },
    weather: { reported: null, receivedAt: null, freshness: 'unknown', freshnessChangedAt: now, error: null },
    command: null,
    storage: { status: 'ready', error: null },
    homeAssistant: {
      enabled: homeAssistantBridge.enabled,
      status: homeAssistantBridge.enabled ? 'disconnected' : 'disabled',
      discoveryTopic: homeAssistantBridge.enabled ? homeAssistantBridge.topics.discovery : null,
      baseTopic: homeAssistantBridge.enabled ? homeAssistantBridge.baseTopic : null,
      error: null
    }
  };
}

class MqttController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.now = options.now || (() => Date.now());
    this.mqttLibrary = options.mqttLibrary || mqtt;
    this.brokerUrl = options.brokerUrl || MQTT_BROKER_URL;
    this.mqttClientId = options.mqttClientId || MQTT_CLIENT_ID;
    this.mqttUsername = options.mqttUsername ?? MQTT_USERNAME;
    this.mqttPassword = options.mqttPassword ?? MQTT_PASSWORD;
    this.commandTopic = options.commandTopic || MQTT_TOPIC_AIRCON_COMMAND;
    this.stateTopic = options.stateTopic || MQTT_TOPIC_AIRCON_STATE;
    this.weatherTopic = options.weatherTopic || MQTT_TOPIC_TEMPEST_STATS;
    this.airconStaleAfterMs = options.airconStaleAfterMs || AIRCON_STALE_AFTER_MS;
    this.weatherStaleAfterMs = options.weatherStaleAfterMs || WEATHER_STALE_AFTER_MS;
    this.commandTimeoutMs = options.commandTimeoutMs || COMMAND_TIMEOUT_MS;
    this.homeAssistantStateIntervalMs = options.homeAssistantStateIntervalMs || HOME_ASSISTANT_STATE_INTERVAL_MS;
    this.runtimeStore = options.runtimeStore || new RuntimeStore({
      filePath: options.runtimeDataPath,
      legacyDailyPath: options.legacyDailyPath,
      legacyHourlyPath: options.legacyHourlyPath,
      maxObservationGapMs: this.airconStaleAfterMs,
      temperatureSampleIntervalMs: options.temperatureHistorySampleMs || TEMPERATURE_HISTORY_SAMPLE_MS,
      detailedHistoryRetentionDays: options.detailedHistoryRetentionDays || DETAILED_HISTORY_RETENTION_DAYS,
      now: this.now
    });
    this.homeAssistantBridge = options.homeAssistantBridge || new HomeAssistantBridge({
      enabled: options.homeAssistantBridge === null ? false : HOME_ASSISTANT_DISCOVERY_ENABLED,
      discoveryPrefix: HOME_ASSISTANT_DISCOVERY_PREFIX,
      statusTopic: HOME_ASSISTANT_STATUS_TOPIC,
      deviceId: HOME_ASSISTANT_DEVICE_ID,
      deviceName: HOME_ASSISTANT_DEVICE_NAME,
      baseTopic: HOME_ASSISTANT_BASE_TOPIC
    });
    this.client = null;
    this.airconFreshnessTimer = null;
    this.weatherFreshnessTimer = null;
    this.commandTimer = null;
    this.publishTimer = null;
    this.homeAssistantPublishTimer = null;
    this.homeAssistantHeartbeat = null;
    this.homeAssistantRetryTimer = null;
    this.homeAssistantPublishChain = Promise.resolve();
    this.homeAssistantSetupPromise = null;
    this.homeAssistantReady = false;
    this.nextCommandId = 1;
    this.state = createInitialState(this.now(), this.homeAssistantBridge);

    this.runtimeStore.on('warning', (message) => this.setStorageState('warning', message));
    this.runtimeStore.on('error', (error) => this.setStorageState('error', error.message));
  }

  async initialize() {
    await this.runtimeStore.initialize();
  }

  getSnapshot() {
    return { ...clone(this.state), generatedAt: this.now() };
  }

  emitState({ publishHomeAssistant = true } = {}) {
    this.state.revision += 1;
    this.state.updatedAt = this.now();
    this.emit('state', this.getSnapshot());
    if (publishHomeAssistant && this.homeAssistantReady) {
      this.scheduleHomeAssistantStatePublish();
    }
  }

  setStorageState(status, error) {
    this.state.storage = { status, error: error || null };
    this.emitState();
  }

  setMqttState(status, error = null) {
    this.state.mqtt = { status, changedAt: this.now(), error };
    const connectionLost = ['reconnecting', 'offline', 'closed', 'error'].includes(status);
    if (connectionLost) {
      this.homeAssistantReady = false;
      if (this.homeAssistantRetryTimer) {
        clearTimeout(this.homeAssistantRetryTimer);
        this.homeAssistantRetryTimer = null;
      }
      if (this.state.homeAssistant.enabled) {
        this.state.homeAssistant.status = 'offline';
        this.state.homeAssistant.error = error;
      }
      for (const domain of ['aircon', 'weather']) {
        if (this.state[domain].receivedAt && this.state[domain].freshness !== 'stale') {
          this.state[domain].freshness = 'stale';
          this.state[domain].freshnessChangedAt = this.now();
        }
      }
    }
    if (
      connectionLost
      && this.state.command
      && ['pending', 'published'].includes(this.state.command.status)
    ) {
      this.clearCommandTimers();
      this.state.command.status = 'failed';
      this.state.command.completedAt = this.now();
      this.state.command.error = 'MQTT disconnected before the command was confirmed';
    }
    this.emitState();
  }

  start() {
    if (this.client) {
      return;
    }

    this.setMqttState('connecting');
    const connectOptions = {
      reconnectPeriod: 5000,
      clean: true,
      clientId: this.mqttClientId
    };
    if (this.mqttUsername) {
      connectOptions.username = this.mqttUsername;
    }
    if (this.mqttPassword) {
      connectOptions.password = this.mqttPassword;
    }
    const will = this.homeAssistantBridge.getWill();
    if (will) {
      connectOptions.will = will;
    }
    this.client = this.mqttLibrary.connect(this.brokerUrl, connectOptions);

    this.client.on('connect', () => {
      this.setMqttState('connected');
      const topics = [...new Set([
        this.stateTopic,
        this.weatherTopic,
        ...this.homeAssistantBridge.getSubscriptions()
      ])];
      this.client.subscribe(topics, { qos: 1 }, (error) => {
        if (error) {
          this.setMqttState('error', error.message);
          return;
        }
        this.requestStatus();
        if (!this.state.aircon.receivedAt) {
          this.resetFreshnessTimer('aircon');
        }
        if (!this.state.weather.receivedAt) {
          this.resetFreshnessTimer('weather');
        }
        this.publishHomeAssistantSetup().catch((publishError) => {
          this.setHomeAssistantError(publishError.message);
        });
      });
    });
    this.client.on('reconnect', () => this.setMqttState('reconnecting'));
    this.client.on('offline', () => this.setMqttState('offline'));
    this.client.on('close', () => this.setMqttState('closed'));
    this.client.on('error', (error) => this.setMqttState('error', error.message));
    this.client.on('message', (topic, messageBuffer) => this.handleMessage(topic, messageBuffer.toString()));
    if (this.homeAssistantBridge.enabled) {
      this.homeAssistantHeartbeat = setInterval(
        () => this.scheduleHomeAssistantStatePublish(),
        this.homeAssistantStateIntervalMs
      );
      this.homeAssistantHeartbeat.unref?.();
    }
  }

  handleMessage(topic, message) {
    const homeAssistantMessage = this.homeAssistantBridge.parseMessage(topic, message);
    if (homeAssistantMessage) {
      this.handleHomeAssistantMessage(homeAssistantMessage, topic, message);
      return;
    }
    if (topic === this.stateTopic) {
      if (this.stateTopic === this.commandTopic && (message === 'status' || parseCommand(message))) {
        return;
      }
      this.handleAirconMessage(message);
      return;
    }
    if (topic === this.weatherTopic) {
      this.handleWeatherMessage(message);
    }
  }

  handleAirconMessage(message) {
    let payload;
    try {
      payload = JSON.parse(message);
      const receivedAt = this.now();
      const reported = normalizeAirconPayload(payload, this.state.aircon.reported, receivedAt);
      const cooling = reported.compressorOn === null
        ? reported.task === 'cooling'
        : reported.compressorOn;
      this.runtimeStore.recordObservation({
        cooling,
        temperature: reported.temp,
        receivedAt
      });
      this.state.aircon = {
        reported,
        receivedAt,
        freshness: 'fresh',
        freshnessChangedAt: receivedAt,
        error: null
      };
      this.resetFreshnessTimer('aircon');
      this.confirmCommandIfMatched(reported);
      this.emitState();
    } catch (error) {
      this.state.aircon.error = `Invalid status: ${error.message}`;
      this.emitState();
    }
  }

  handleWeatherMessage(message) {
    try {
      const payload = JSON.parse(message);
      const reported = normalizeWeatherPayload(payload);
      const receivedAt = this.now();
      this.state.weather = {
        reported,
        receivedAt,
        freshness: 'fresh',
        freshnessChangedAt: receivedAt,
        error: null
      };
      this.resetFreshnessTimer('weather');
      this.emitState();
    } catch (error) {
      this.state.weather.error = `Invalid weather status: ${error.message}`;
      this.emitState();
    }
  }

  resetFreshnessTimer(domain) {
    const timerProperty = domain === 'aircon' ? 'airconFreshnessTimer' : 'weatherFreshnessTimer';
    const delay = domain === 'aircon' ? this.airconStaleAfterMs : this.weatherStaleAfterMs;
    if (this[timerProperty]) {
      clearTimeout(this[timerProperty]);
    }
    this[timerProperty] = setTimeout(() => {
      this[timerProperty] = null;
      this.state[domain].freshness = 'stale';
      this.state[domain].freshnessChangedAt = this.now();
      this.emitState();
      if (domain === 'aircon') {
        this.requestStatus();
      }
    }, delay);
    this[timerProperty].unref?.();
  }

  requestStatus() {
    return this.publishRaw('status', 0);
  }

  publishRaw(message, qos = 1) {
    return this.publishTopic(this.commandTopic, message, { qos, retain: false });
  }

  publishTopic(topic, message, { qos = 1, retain = false } = {}) {
    if (!this.client || !this.client.connected) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.client.publish(topic, message, { qos, retain }, (error) => resolve(!error));
    });
  }

  async sendCommand(rawCommand, source = 'touchscreen') {
    const parsed = parseCommand(rawCommand);
    if (!parsed) {
      return { ok: false, error: 'Command is not allowed' };
    }

    this.clearCommandTimers();
    const commandId = this.nextCommandId;
    this.nextCommandId += 1;
    this.state.command = {
      id: commandId,
      ...parsed,
      source,
      status: 'pending',
      sentAt: this.now(),
      publishedAt: null,
      completedAt: null,
      error: null
    };
    this.emitState();

    if (!this.client || !this.client.connected) {
      this.failCommand(commandId, 'MQTT is not connected');
      return { ok: false, error: 'MQTT is not connected' };
    }

    const published = await Promise.race([
      this.publishRaw(parsed.raw, 1),
      new Promise((resolve) => {
        this.publishTimer = setTimeout(() => resolve(false), Math.min(5000, this.commandTimeoutMs));
        this.publishTimer.unref?.();
      })
    ]);
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }

    if (!published) {
      this.failCommand(commandId, 'The broker did not acknowledge the command');
      return { ok: false, error: 'The broker did not acknowledge the command' };
    }

    const currentCommand = this.state.command;
    if (!currentCommand || currentCommand.id !== commandId) {
      return { ok: false, error: 'Command was superseded' };
    }
    if (currentCommand.status === 'confirmed') {
      return { ok: true };
    }
    if (currentCommand.status !== 'pending') {
      return { ok: false, error: currentCommand.error || 'Command did not complete' };
    }
    this.state.command.status = 'published';
    this.state.command.publishedAt = this.now();
    this.emitState();
    this.commandTimer = setTimeout(() => {
      this.commandTimer = null;
      this.failCommand(commandId, 'No matching status was received before the timeout', 'timed-out');
    }, this.commandTimeoutMs);
    this.commandTimer.unref?.();
    this.requestStatus();
    return { ok: true };
  }

  confirmCommandIfMatched(reported) {
    const command = this.state.command;
    if (!command || !['pending', 'published'].includes(command.status) || !commandMatchesReported(command, reported)) {
      return;
    }
    this.clearCommandTimers();
    command.status = 'confirmed';
    command.completedAt = this.now();
    command.error = null;
  }

  failCommand(commandId, message, status = 'failed') {
    if (
      !this.state.command
      || this.state.command.id !== commandId
      || !['pending', 'published'].includes(this.state.command.status)
    ) {
      return;
    }
    this.clearCommandTimers();
    this.state.command.status = status;
    this.state.command.completedAt = this.now();
    this.state.command.error = message;
    this.emitState();
  }

  clearCommandTimers() {
    if (this.commandTimer) {
      clearTimeout(this.commandTimer);
      this.commandTimer = null;
    }
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
  }

  getRuntimeReport() {
    return this.runtimeStore.getReport();
  }

  setHomeAssistantError(message) {
    if (!this.state.homeAssistant.enabled) {
      return;
    }
    this.state.homeAssistant.status = 'error';
    this.state.homeAssistant.error = message;
    this.emitState({ publishHomeAssistant: false });
    if (!this.homeAssistantReady && this.client?.connected && !this.homeAssistantRetryTimer) {
      this.homeAssistantRetryTimer = setTimeout(() => {
        this.homeAssistantRetryTimer = null;
        this.publishHomeAssistantSetup().catch((error) => this.setHomeAssistantError(error.message));
      }, 30000);
      this.homeAssistantRetryTimer.unref?.();
    }
  }

  publishHomeAssistantSetup() {
    if (!this.homeAssistantBridge.enabled || !this.client?.connected) {
      return Promise.resolve();
    }
    if (this.homeAssistantSetupPromise) {
      return this.homeAssistantSetupPromise;
    }
    this.homeAssistantSetupPromise = this.performHomeAssistantSetup()
      .finally(() => {
        this.homeAssistantSetupPromise = null;
      });
    return this.homeAssistantSetupPromise;
  }

  async performHomeAssistantSetup() {
    if (this.homeAssistantRetryTimer) {
      clearTimeout(this.homeAssistantRetryTimer);
      this.homeAssistantRetryTimer = null;
    }

    this.homeAssistantReady = false;
    this.state.homeAssistant.status = 'publishing';
    this.state.homeAssistant.error = null;
    this.emitState({ publishHomeAssistant: false });

    const published = await this.publishTopic(
      this.homeAssistantBridge.topics.discovery,
      JSON.stringify(this.homeAssistantBridge.buildDiscoveryPayload()),
      { qos: 1, retain: true }
    );
    if (!published) {
      throw new Error('Failed to publish Home Assistant discovery');
    }

    this.homeAssistantReady = true;
    this.state.homeAssistant.status = 'online';
    this.state.homeAssistant.error = null;
    this.emitState({ publishHomeAssistant: false });
    await this.publishHomeAssistantState();
  }

  scheduleHomeAssistantStatePublish() {
    if (this.homeAssistantPublishTimer || !this.homeAssistantReady) {
      return;
    }
    this.homeAssistantPublishTimer = setTimeout(() => {
      this.homeAssistantPublishTimer = null;
      this.homeAssistantPublishChain = this.homeAssistantPublishChain
        .then(() => this.publishHomeAssistantState())
        .catch((error) => this.setHomeAssistantError(error.message));
    }, 10);
    this.homeAssistantPublishTimer.unref?.();
  }

  async publishHomeAssistantState() {
    if (!this.homeAssistantReady || !this.client?.connected) {
      return;
    }
    const snapshot = this.getSnapshot();
    const statePayload = this.homeAssistantBridge.buildStatePayload(
      snapshot,
      this.runtimeStore.getReport(),
      this.now()
    );
    const statePublished = await this.publishTopic(
      this.homeAssistantBridge.topics.state,
      JSON.stringify(statePayload),
      { qos: 1, retain: true }
    );
    const availabilityPublished = await this.publishTopic(
      this.homeAssistantBridge.topics.availability,
      statePayload.available ? 'online' : 'offline',
      { qos: 1, retain: true }
    );
    if (!statePublished || !availabilityPublished) {
      throw new Error('Failed to publish Home Assistant state');
    }
    if (this.state.homeAssistant.status === 'error') {
      this.state.homeAssistant.status = 'online';
      this.state.homeAssistant.error = null;
      this.emitState({ publishHomeAssistant: false });
    }
  }

  handleHomeAssistantMessage(message, topic, rawPayload) {
    if (message.type === 'birth') {
      this.publishHomeAssistantSetup().catch((error) => this.setHomeAssistantError(error.message));
      return;
    }
    if (message.type === 'ignored') {
      return;
    }
    if (message.type === 'invalid') {
      this.publishHomeAssistantCommandResult({
        ok: false,
        topic,
        payload: rawPayload,
        error: message.error
      });
      return;
    }
    if (message.type === 'command') {
      this.sendCommand(message.command, 'home-assistant')
        .then((result) => this.publishHomeAssistantCommandResult({
          ...result,
          topic,
          payload: rawPayload,
          command: message.command
        }))
        .catch((error) => this.publishHomeAssistantCommandResult({
          ok: false,
          topic,
          payload: rawPayload,
          command: message.command,
          error: error.message
        }));
    }
  }

  publishHomeAssistantCommandResult(result) {
    if (!this.homeAssistantBridge.enabled) {
      return;
    }
    const payload = JSON.stringify({ ...result, at: new Date(this.now()).toISOString() });
    this.publishTopic(this.homeAssistantBridge.topics.commandResult, payload, { qos: 1, retain: false })
      .then((published) => {
        if (!published && this.client?.connected) {
          this.setHomeAssistantError('Failed to publish the Home Assistant command result');
        }
      })
      .catch((error) => this.setHomeAssistantError(error.message));
  }

  async stop() {
    this.clearCommandTimers();
    for (const timerProperty of ['airconFreshnessTimer', 'weatherFreshnessTimer']) {
      if (this[timerProperty]) {
        clearTimeout(this[timerProperty]);
        this[timerProperty] = null;
      }
    }
    if (this.homeAssistantPublishTimer) {
      clearTimeout(this.homeAssistantPublishTimer);
      this.homeAssistantPublishTimer = null;
    }
    if (this.homeAssistantHeartbeat) {
      clearInterval(this.homeAssistantHeartbeat);
      this.homeAssistantHeartbeat = null;
    }
    if (this.homeAssistantRetryTimer) {
      clearTimeout(this.homeAssistantRetryTimer);
      this.homeAssistantRetryTimer = null;
    }
    if (this.homeAssistantSetupPromise) {
      await this.homeAssistantSetupPromise.catch(() => {});
    }
    await this.homeAssistantPublishChain;
    if (this.homeAssistantBridge.enabled && this.client?.connected) {
      await this.publishTopic(
        this.homeAssistantBridge.topics.availability,
        'offline',
        { qos: 1, retain: true }
      );
    }
    this.homeAssistantReady = false;
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    await this.runtimeStore.flush();
  }
}

module.exports = {
  MqttController,
  commandMatchesReported,
  normalizeAirconPayload,
  normalizeBoolean,
  normalizeTask,
  normalizeWeatherPayload,
  parseCommand,
  parseDurationStringToMilliseconds,
  parseRuntime
};
