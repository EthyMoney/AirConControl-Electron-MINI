const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  HomeAssistantBridge,
  deriveClimateAction,
  deriveClimateMode,
  getLocalDayKey,
  sanitizeIdentifier,
  sanitizeTopic
} = require('../home-assistant-bridge');
const { MqttController } = require('../mqtt-controller');

class FakeRuntimeStore extends EventEmitter {
  constructor(now) {
    super();
    this.now = now;
    this.observations = [];
  }

  async initialize() {}

  recordObservation(observation) {
    this.observations.push(observation);
  }

  getReport() {
    return {
      daily: { [getLocalDayKey(new Date(this.now))]: 125000 },
      hourly: {},
      gaps: []
    };
  }

  async flush() {}
}

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.published = [];
    this.subscriptions = [];
  }

  subscribe(topics, options, callback) {
    this.subscriptions.push({ topics, options });
    callback(null);
  }

  publish(topic, message, options, callback) {
    this.published.push({ topic, message, options });
    callback(null);
  }

  end() {
    this.connected = false;
  }
}

function createBridge() {
  return new HomeAssistantBridge({
    enabled: true,
    discoveryPrefix: 'homeassistant',
    statusTopic: 'homeassistant/status',
    deviceId: 'Shop AC #1',
    deviceName: 'Shop Climate Control',
    baseTopic: 'airconcontrol/shop'
  });
}

test('builds current Home Assistant device discovery for a non-optimistic climate', () => {
  const bridge = createBridge();
  const discovery = bridge.buildDiscoveryPayload();

  assert.equal(bridge.deviceId, 'shop_ac_1');
  assert.equal(bridge.topics.discovery, 'homeassistant/device/shop_ac_1/config');
  assert.deepEqual(discovery.device.identifiers, ['shop_ac_1']);
  assert.equal(discovery.origin.name, 'AirConControl Electron');
  assert.equal(discovery.availability_topic, 'airconcontrol/shop/availability');
  assert.equal(discovery.components.climate.platform, 'climate');
  assert.equal(discovery.components.climate.optimistic, false);
  assert.deepEqual(discovery.components.climate.modes, ['off', 'cool']);
  assert.equal(discovery.components.climate.temperature_command_topic, 'airconcontrol/shop/temperature/set');
  assert.equal(discovery.components.climate.mode_state_template, '{{ value_json.mode }}');
  assert.equal(discovery.components.fan.platform, 'binary_sensor');
  assert.equal(discovery.components.cooling_runtime_today.device_class, 'duration');
});

test('normalizes bridge identifiers, topics, modes, and commands', () => {
  const bridge = createBridge();
  assert.equal(sanitizeIdentifier(' Shop AC #1 ', 'fallback'), 'shop_ac_1');
  assert.equal(sanitizeTopic('/aircon/shop/', 'fallback'), 'aircon/shop');
  assert.equal(sanitizeTopic('aircon/+/bad', 'fallback'), 'fallback');
  assert.equal(deriveClimateMode({ enabled: false, task: 'off' }), 'off');
  assert.equal(deriveClimateMode({ enabled: true, task: 'idle' }), 'cool');
  assert.equal(deriveClimateAction({ enabled: true, task: 'cooling' }), 'cooling');
  assert.deepEqual(bridge.parseMessage(bridge.topics.modeCommand, 'cool'), { type: 'command', command: 'on' });
  assert.deepEqual(bridge.parseMessage(bridge.topics.powerCommand, 'OFF'), { type: 'command', command: 'off' });
  assert.deepEqual(bridge.parseMessage(bridge.topics.temperatureCommand, '72.0'), { type: 'command', command: 'set-72' });
  assert.equal(bridge.parseMessage(bridge.statusTopic, 'online').type, 'birth');
  assert.equal(bridge.parseMessage(bridge.topics.temperatureCommand, '120').type, 'invalid');
});

test('builds retained normalized state and availability from the canonical snapshot', () => {
  const bridge = createBridge();
  const now = new Date(2026, 6, 26, 14, 0, 0).getTime();
  const state = bridge.buildStatePayload({
    revision: 12,
    mqtt: { status: 'connected' },
    aircon: {
      freshness: 'fresh',
      receivedAt: now - 1000,
      reported: {
        enabled: true,
        task: 'cooling',
        temp: 74,
        setTemp: 72,
        fanOn: true,
        compressorOn: true,
        runtimeMs: 90000
      }
    },
    command: { source: 'home-assistant', type: 'set-temperature', status: 'confirmed', error: null }
  }, {
    daily: { [getLocalDayKey(new Date(now))]: 125000 }
  }, now);

  assert.equal(state.available, true);
  assert.equal(state.mode, 'cool');
  assert.equal(state.action, 'cooling');
  assert.equal(state.current_temperature, 74);
  assert.equal(state.temperature, 72);
  assert.equal(state.cooling_runtime_today_seconds, 125);
  assert.equal(state.command.source, 'home-assistant');
});

test('controller publishes discovery/state and routes Home Assistant commands', async () => {
  let now = new Date(2026, 6, 26, 14, 0, 0).getTime();
  let connectOptions;
  const client = new FakeMqttClient();
  const bridge = createBridge();
  const controller = new MqttController({
    now: () => now,
    mqttLibrary: {
      connect: (_url, options) => {
        connectOptions = options;
        return client;
      }
    },
    runtimeStore: new FakeRuntimeStore(now),
    homeAssistantBridge: bridge,
    mqttClientId: 'test_aircon_bridge',
    mqttUsername: 'bridge-user',
    mqttPassword: 'bridge-password',
    commandTopic: 'device/command',
    stateTopic: 'device/state',
    weatherTopic: 'weather/state',
    commandTimeoutMs: 1000
  });

  await controller.initialize();
  controller.start();
  assert.equal(connectOptions.will.topic, bridge.topics.availability);
  assert.equal(connectOptions.will.payload, 'offline');
  assert.equal(connectOptions.clientId, 'test_aircon_bridge');
  assert.equal(connectOptions.username, 'bridge-user');
  assert.equal(connectOptions.password, 'bridge-password');
  client.emit('connect');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const discoveryMessages = () => client.published.filter((entry) => entry.topic === bridge.topics.discovery);
  assert.equal(discoveryMessages().length, 1);
  assert.equal(discoveryMessages()[0].options.retain, true);
  assert.equal(controller.getSnapshot().homeAssistant.status, 'online');
  assert.equal(client.subscriptions[0].topics.includes(bridge.topics.temperatureCommand), true);

  controller.handleAirconMessage(JSON.stringify({
    Task: 'cooling',
    Enabled: true,
    Temp: 74,
    SetTemp: 72,
    FanOn: true,
    CompressorOn: true,
    RuntimeSeconds: 90
  }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const lastStateMessage = client.published.filter((entry) => entry.topic === bridge.topics.state).at(-1);
  const lastAvailability = client.published.filter((entry) => entry.topic === bridge.topics.availability).at(-1);
  assert.equal(JSON.parse(lastStateMessage.message).action, 'cooling');
  assert.equal(lastStateMessage.options.retain, true);
  assert.equal(lastAvailability.message, 'online');

  controller.handleMessage(bridge.topics.temperatureCommand, '75');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.published.some((entry) => entry.topic === 'device/command' && entry.message === 'set-75'), true);
  assert.equal(controller.getSnapshot().command.source, 'home-assistant');
  controller.handleAirconMessage(JSON.stringify({ Task: 'cooling', Enabled: true, Temp: 74, SetTemp: 75 }));
  assert.equal(controller.getSnapshot().command.status, 'confirmed');

  controller.handleMessage(bridge.statusTopic, 'online');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(discoveryMessages().length, 2);

  await controller.stop();
  assert.equal(client.published.filter((entry) => entry.topic === bridge.topics.availability).at(-1).message, 'offline');
});
