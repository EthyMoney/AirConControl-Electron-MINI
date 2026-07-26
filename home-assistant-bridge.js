const packageMetadata = require('./package.json');

const MIN_SET_TEMPERATURE = 50;
const MAX_SET_TEMPERATURE = 90;

function sanitizeIdentifier(value, fallback) {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

function sanitizeTopic(value, fallback) {
  const topic = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!topic || topic.includes('#') || topic.includes('+') || topic.includes('\0')) {
    return fallback;
  }
  return topic;
}

function getLocalDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function deriveClimateMode(reported) {
  if (!reported) {
    return 'unknown';
  }
  if (reported.enabled === false || reported.task === 'off') {
    return 'off';
  }
  if (reported.enabled === true || ['cooling', 'idle', 'heating'].includes(reported.task)) {
    return 'cool';
  }
  return 'unknown';
}

function deriveClimateAction(reported) {
  if (!reported) {
    return 'off';
  }
  if (reported.enabled === false || reported.task === 'off') {
    return 'off';
  }
  if (reported.task === 'cooling') {
    return 'cooling';
  }
  if (reported.task === 'heating') {
    return 'heating';
  }
  return 'idle';
}

class HomeAssistantBridge {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.discoveryPrefix = sanitizeTopic(options.discoveryPrefix, 'homeassistant');
    this.statusTopic = sanitizeTopic(options.statusTopic, 'homeassistant/status');
    this.deviceId = sanitizeIdentifier(options.deviceId, 'airconcontrol_shop');
    this.deviceName = String(options.deviceName || 'Shop Climate Control').trim() || 'Shop Climate Control';
    this.baseTopic = sanitizeTopic(options.baseTopic, `airconcontrol/${this.deviceId}`);
    this.version = packageMetadata.version;
    this.topics = {
      discovery: `${this.discoveryPrefix}/device/${this.deviceId}/config`,
      availability: `${this.baseTopic}/availability`,
      state: `${this.baseTopic}/state`,
      modeCommand: `${this.baseTopic}/mode/set`,
      powerCommand: `${this.baseTopic}/power/set`,
      temperatureCommand: `${this.baseTopic}/temperature/set`,
      commandResult: `${this.baseTopic}/command/result`
    };
  }

  getWill() {
    if (!this.enabled) {
      return null;
    }
    return {
      topic: this.topics.availability,
      payload: 'offline',
      qos: 1,
      retain: true
    };
  }

  getSubscriptions() {
    if (!this.enabled) {
      return [];
    }
    return [
      this.statusTopic,
      this.topics.modeCommand,
      this.topics.powerCommand,
      this.topics.temperatureCommand
    ];
  }

  buildDiscoveryPayload() {
    const stateTopic = this.topics.state;
    const availabilityTopic = this.topics.availability;
    const uniqueId = (suffix) => `${this.deviceId}_${suffix}`;

    return {
      device: {
        identifiers: [this.deviceId],
        name: this.deviceName,
        manufacturer: 'AirConControl',
        model: 'Electron MQTT Bridge',
        sw_version: this.version
      },
      origin: {
        name: 'AirConControl Electron',
        sw_version: this.version,
        support_url: 'https://github.com/EthyMoney/AirConControl-Electron-MINI'
      },
      availability_topic: availabilityTopic,
      payload_available: 'online',
      payload_not_available: 'offline',
      qos: 1,
      components: {
        climate: {
          platform: 'climate',
          unique_id: uniqueId('climate'),
          default_entity_id: `climate.${this.deviceId}`,
          name: null,
          icon: 'mdi:air-conditioner',
          modes: ['off', 'cool'],
          mode_command_topic: this.topics.modeCommand,
          mode_state_topic: stateTopic,
          mode_state_template: '{{ value_json.mode }}',
          power_command_topic: this.topics.powerCommand,
          payload_on: 'ON',
          payload_off: 'OFF',
          temperature_command_topic: this.topics.temperatureCommand,
          temperature_state_topic: stateTopic,
          temperature_state_template: '{{ value_json.temperature }}',
          current_temperature_topic: stateTopic,
          current_temperature_template: '{{ value_json.current_temperature }}',
          action_topic: stateTopic,
          action_template: '{{ value_json.action }}',
          min_temp: MIN_SET_TEMPERATURE,
          max_temp: MAX_SET_TEMPERATURE,
          temp_step: 1,
          precision: 1,
          temperature_unit: 'F',
          optimistic: false,
          retain: false,
          message_expiry_interval: { seconds: 30 }
        },
        fan: {
          platform: 'binary_sensor',
          unique_id: uniqueId('fan'),
          default_entity_id: `binary_sensor.${this.deviceId}_fan`,
          name: 'Fan',
          icon: 'mdi:fan',
          entity_category: 'diagnostic',
          state_topic: stateTopic,
          value_template: "{{ 'ON' if value_json.fan_on == true else 'OFF' if value_json.fan_on == false else 'UNKNOWN' }}",
          payload_on: 'ON',
          payload_off: 'OFF'
        },
        compressor: {
          platform: 'binary_sensor',
          unique_id: uniqueId('compressor'),
          default_entity_id: `binary_sensor.${this.deviceId}_compressor`,
          name: 'Compressor',
          icon: 'mdi:engine',
          entity_category: 'diagnostic',
          state_topic: stateTopic,
          value_template: "{{ 'ON' if value_json.compressor_on == true else 'OFF' if value_json.compressor_on == false else 'UNKNOWN' }}",
          payload_on: 'ON',
          payload_off: 'OFF'
        },
        cooling_runtime_today: {
          platform: 'sensor',
          unique_id: uniqueId('cooling_runtime_today'),
          default_entity_id: `sensor.${this.deviceId}_cooling_runtime_today`,
          name: 'Cooling runtime today',
          icon: 'mdi:timer-outline',
          device_class: 'duration',
          entity_category: 'diagnostic',
          state_topic: stateTopic,
          value_template: '{{ value_json.cooling_runtime_today_seconds }}',
          unit_of_measurement: 's'
        },
        last_status: {
          platform: 'sensor',
          unique_id: uniqueId('last_status'),
          default_entity_id: `sensor.${this.deviceId}_last_status`,
          name: 'Last status',
          icon: 'mdi:clock-check-outline',
          device_class: 'timestamp',
          entity_category: 'diagnostic',
          state_topic: stateTopic,
          value_template: '{{ value_json.last_status }}'
        }
      }
    };
  }

  buildStatePayload(snapshot, runtimeReport, now = Date.now()) {
    const aircon = snapshot.aircon || {};
    const reported = aircon.reported || null;
    const dayKey = getLocalDayKey(new Date(now));
    const runtimeMs = Number(runtimeReport?.daily?.[dayKey] || 0);
    const available = snapshot.mqtt?.status === 'connected'
      && aircon.freshness === 'fresh'
      && Boolean(reported);

    return {
      revision: snapshot.revision,
      updated_at: new Date(now).toISOString(),
      available,
      mode: deriveClimateMode(reported),
      action: deriveClimateAction(reported),
      current_temperature: reported?.temp ?? null,
      temperature: reported?.setTemp ?? null,
      enabled: reported?.enabled ?? null,
      task: reported?.task ?? 'unknown',
      fan_on: reported?.fanOn ?? null,
      compressor_on: reported?.compressorOn ?? null,
      runtime_seconds: Number.isFinite(reported?.runtimeMs) ? Math.floor(reported.runtimeMs / 1000) : null,
      cooling_runtime_today_seconds: Math.floor(Math.max(0, runtimeMs) / 1000),
      freshness: aircon.freshness || 'unknown',
      last_status: Number.isFinite(aircon.receivedAt) ? new Date(aircon.receivedAt).toISOString() : null,
      command: snapshot.command
        ? {
            source: snapshot.command.source,
            type: snapshot.command.type,
            status: snapshot.command.status,
            error: snapshot.command.error
          }
        : null
    };
  }

  parseMessage(topic, payload) {
    if (!this.enabled) {
      return null;
    }

    const value = String(payload).trim();
    if (topic === this.statusTopic) {
      return value.toLowerCase() === 'online' ? { type: 'birth' } : { type: 'ignored' };
    }
    if (topic === this.topics.modeCommand) {
      const mode = value.toLowerCase();
      if (mode === 'off') return { type: 'command', command: 'off' };
      if (mode === 'cool') return { type: 'command', command: 'on' };
      return { type: 'invalid', error: `Unsupported HVAC mode: ${value}` };
    }
    if (topic === this.topics.powerCommand) {
      const power = value.toLowerCase();
      if (power === 'on') return { type: 'command', command: 'on' };
      if (power === 'off') return { type: 'command', command: 'off' };
      return { type: 'invalid', error: `Unsupported power payload: ${value}` };
    }
    if (topic === this.topics.temperatureCommand) {
      const temperature = Number(value);
      if (!Number.isFinite(temperature) || temperature < MIN_SET_TEMPERATURE || temperature > MAX_SET_TEMPERATURE) {
        return { type: 'invalid', error: `Temperature must be between ${MIN_SET_TEMPERATURE} and ${MAX_SET_TEMPERATURE}` };
      }
      return { type: 'command', command: `set-${Math.round(temperature)}` };
    }
    return null;
  }
}

module.exports = {
  HomeAssistantBridge,
  deriveClimateAction,
  deriveClimateMode,
  getLocalDayKey,
  sanitizeIdentifier,
  sanitizeTopic
};
