const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  MqttController,
  normalizeAirconPayload,
  normalizeTask,
  normalizeWeatherPayload,
  parseCommand,
  parseDurationStringToMilliseconds,
  parseRuntime
} = require('../mqtt-controller');

class FakeRuntimeStore extends EventEmitter {
  constructor() {
    super();
    this.observations = [];
  }

  async initialize() {}

  recordObservation(observation) {
    this.observations.push(observation);
  }

  getReport() {
    return { daily: {}, hourly: {}, gaps: [] };
  }

  async flush() {}
}

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.published = [];
    this.subscriptions = [];
    this.deferredPublishCallbacks = null;
  }

  subscribe(topics, options, callback) {
    this.subscriptions.push({ topics, options });
    callback(null);
  }

  publish(topic, message, options, callback) {
    this.published.push({ topic, message, options });
    if (this.deferredPublishCallbacks) {
      this.deferredPublishCallbacks.push(callback);
    } else {
      callback(null);
    }
  }

  end() {
    this.connected = false;
  }
}

test('duration parsing handles clocks before numeric fallbacks', () => {
  assert.equal(parseDurationStringToMilliseconds('01:30:00'), 5400000);
  assert.equal(parseDurationStringToMilliseconds('2hr 5min 3sec'), 7503000);
  assert.equal(parseDurationStringToMilliseconds('00:75:00'), null);
  assert.deepEqual(parseRuntime({ Runtime: '01:30:00' }, 0), {
    milliseconds: 5400000,
    source: 'Runtime'
  });
});

test('runtime units are explicit and generic numeric values remain legacy milliseconds', () => {
  assert.equal(parseRuntime({ RuntimeSeconds: '90' }).milliseconds, 90000);
  assert.equal(parseRuntime({ RuntimeMinutes: 2 }).milliseconds, 120000);
  assert.equal(parseRuntime({ Runtime: 1500 }).milliseconds, 1500);
  assert.equal(parseRuntime({ RuntimeStartedAt: 1000 }, 5000000).milliseconds, 4000000);
});

test('unknown tasks and invalid telemetry remain visibly unknown', () => {
  assert.equal(normalizeTask('defrost'), 'unknown');
  const status = normalizeAirconPayload({ Task: 'defrost', Temp: '72.5', SetTemp: 70, Enabled: true });
  assert.equal(status.task, 'unknown');
  assert.equal(status.taskRaw, 'defrost');
  assert.equal(status.temp, 72.5);
  assert.throws(() => normalizeAirconPayload({ hello: 'world' }), /missing/);
  assert.throws(
    () => normalizeAirconPayload({ Task: 'cooling', Runtime: 'not a duration' }),
    /Runtime has an invalid/
  );
  assert.throws(() => normalizeWeatherPayload({ air_temperature: 72 }), /requires numeric/);
  assert.throws(
    () => normalizeWeatherPayload({ air_temperature: 72, relative_humidity: 120 }),
    /requires numeric/
  );
});

test('command parser allowlists power and safe setpoint commands', () => {
  assert.deepEqual(parseCommand('on').desired, { enabled: true });
  assert.deepEqual(parseCommand('set-72').desired, { setTemp: 72 });
  assert.equal(parseCommand('set-99'), null);
  assert.equal(parseCommand('status'), null);
  assert.equal(parseCommand('arbitrary mqtt payload'), null);
});

test('controller separates weather errors and confirms commands from reported state', async () => {
  let now = 1000000;
  const runtimeStore = new FakeRuntimeStore();
  const client = new FakeMqttClient();
  const controller = new MqttController({
    now: () => now,
    mqttLibrary: { connect: () => client },
    runtimeStore,
    homeAssistantBridge: null,
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state',
    commandTimeoutMs: 1000
  });

  await controller.initialize();
  controller.start();
  client.emit('connect');
  controller.handleAirconMessage(JSON.stringify({ Task: 'idle', Enabled: true, Temp: 73, SetTemp: 72 }));
  const airconBeforeWeatherError = controller.getSnapshot().aircon;

  controller.handleWeatherMessage('{"air_temperature":"bad"}');
  const afterWeatherError = controller.getSnapshot();
  assert.deepEqual(afterWeatherError.aircon, airconBeforeWeatherError);
  assert.equal(afterWeatherError.mqtt.status, 'connected');
  assert.match(afterWeatherError.weather.error, /Invalid weather status/);

  const result = await controller.sendCommand('set-74');
  assert.equal(result.ok, true);
  assert.equal(controller.getSnapshot().command.status, 'published');
  now += 500;
  controller.handleAirconMessage(JSON.stringify({ Task: 'idle', Enabled: true, Temp: 73, SetTemp: 74 }));
  assert.equal(controller.getSnapshot().command.status, 'confirmed');
  assert.deepEqual(runtimeStore.observations.at(-1), {
    cooling: false,
    temperature: 73,
    receivedAt: now
  });
  await controller.stop();
});

test('freshness deadlines and command timeouts become explicit state', async () => {
  const runtimeStore = new FakeRuntimeStore();
  const client = new FakeMqttClient();
  const controller = new MqttController({
    mqttLibrary: { connect: () => client },
    runtimeStore,
    homeAssistantBridge: null,
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state',
    airconStaleAfterMs: 20,
    weatherStaleAfterMs: 20,
    commandTimeoutMs: 20
  });

  await controller.initialize();
  controller.start();
  client.emit('connect');
  controller.handleAirconMessage(JSON.stringify({ Task: 'idle', Enabled: true, Temp: 73, SetTemp: 72 }));
  await controller.sendCommand('set-74');
  await new Promise((resolve) => setTimeout(resolve, 35));

  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.aircon.freshness, 'stale');
  assert.equal(snapshot.weather.freshness, 'stale');
  assert.equal(snapshot.command.status, 'timed-out');
  await controller.stop();
});

test('disconnecting during publish cannot resurrect a failed command', async () => {
  const runtimeStore = new FakeRuntimeStore();
  const client = new FakeMqttClient();
  const controller = new MqttController({
    mqttLibrary: { connect: () => client },
    runtimeStore,
    homeAssistantBridge: null,
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state',
    commandTimeoutMs: 1000
  });

  await controller.initialize();
  controller.start();
  client.emit('connect');
  client.deferredPublishCallbacks = [];
  const commandResult = controller.sendCommand('off');
  client.emit('offline');
  client.deferredPublishCallbacks.shift()(null);

  assert.equal((await commandResult).ok, false);
  assert.equal(controller.getSnapshot().command.status, 'failed');
  assert.match(controller.getSnapshot().command.error, /disconnected/);
  await controller.stop();
});
