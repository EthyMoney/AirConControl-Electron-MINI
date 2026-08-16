const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { gunzipSync } = require('node:zlib');
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

  getTodayRuntimeMs() {
    return 0;
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
    callback(this.subscribeError || null);
  }

  publish(topic, message, options, callback) {
    this.published.push({ topic, message, options });
    if (this.deferredPublishCallbacks) {
      this.deferredPublishCallbacks.push(callback);
    } else {
      callback(null);
    }
  }

  end(force, _options, callback) {
    this.endForce = force;
    this.connected = false;
    callback?.();
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

test('a stale air conditioner keeps being polled instead of being asked exactly once', async () => {
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
    airconStaleRetryMs: 20,
    weatherStaleAfterMs: 100000
  });

  await controller.initialize();
  controller.start();
  client.emit('connect');
  controller.handleAirconMessage(JSON.stringify({ Task: 'idle', Enabled: true, Temp: 73, SetTemp: 72 }));

  const statusRequests = () => client.published.filter((entry) => entry.message === 'status').length;
  const beforeStale = statusRequests();
  await new Promise((resolve) => setTimeout(resolve, 110));

  // One request on going stale, then repeats on the retry cadence.
  assert.ok(
    statusRequests() - beforeStale >= 3,
    `expected repeated status polls, saw ${statusRequests() - beforeStale}`
  );
  assert.equal(controller.getSnapshot().aircon.freshness, 'stale');

  // A fresh status ends the retry loop and restores the normal deadline.
  controller.handleAirconMessage(JSON.stringify({ Task: 'cooling', Enabled: true, Temp: 71, SetTemp: 70 }));
  assert.equal(controller.getSnapshot().aircon.freshness, 'fresh');
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
  client.deferredPublishCallbacks = null;
  await controller.stop();
});

test('publishes fleet version diagnostics and shares leader runtime history', async () => {
  const runtimeStore = new FakeRuntimeStore();
  const client = new FakeMqttClient();
  let connectOptions;
  const controller = new MqttController({
    mqttLibrary: { connect: (_url, options) => {
      connectOptions = options;
      return client;
    } },
    runtimeStore,
    mqttConnectOptions: { ca: Buffer.from('test-ca'), rejectUnauthorized: true },
    homeAssistantEnabled: true,
    instanceId: 'display-one',
    hostname: 'shop-panel',
    version: '2.3.4',
    fleetBaseTopic: 'aircon/fleet',
    sharedRuntimeTopic: 'aircon/runtime',
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state'
  });

  await controller.initialize();
  controller.start();
  client.emit('connect');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const fleetMessage = client.published.find((entry) => entry.topic === 'aircon/fleet/display-one/status');
  assert.equal(connectOptions.ca.toString(), 'test-ca');
  assert.equal(connectOptions.rejectUnauthorized, true);
  assert.equal(JSON.parse(fleetMessage.message).version, '2.3.4');
  assert.equal(fleetMessage.options.retain, true);
  const runtimeMessage = client.published.find((entry) => entry.topic === 'aircon/runtime');
  const sharedPayload = JSON.parse(gunzipSync(runtimeMessage.message).toString());
  assert.equal(sharedPayload.instanceId, 'display-one');
  assert.deepEqual(sharedPayload.report.daily, {});
  assert.equal(controller.getSnapshot().system.version, '2.3.4');
  await controller.stop();
});

test('standby instances serve the retained shared runtime report', async () => {
  const client = new FakeMqttClient();
  const controller = new MqttController({
    mqttLibrary: { connect: () => client },
    runtimeStore: new FakeRuntimeStore(),
    homeAssistantBridge: null,
    instanceId: 'display-two',
    sharedRuntimeTopic: 'aircon/runtime',
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state'
  });
  await controller.initialize();
  controller.start();
  client.emit('connect');
  controller.setHomeAssistantLeaseState({
    role: 'standby',
    ownerId: 'owner-one',
    ownerInstanceId: 'display-one',
    expiresAt: Date.now() + 30000
  });
  const report = { generatedAt: 1234, timezone: 'UTC', daily: { '2026-08-15': 90000 }, hourly: {}, gaps: [] };
  client.emit('message', 'aircon/runtime', Buffer.from(require('node:zlib').gzipSync(JSON.stringify({
    instanceId: 'display-one',
    version: '2.3.4',
    leaseOwnerId: 'owner-one',
    sequence: 1,
    publishedAt: 2000,
    report
  }))));

  assert.equal(controller.getRuntimeReport().shared, true);
  assert.equal(controller.getRuntimeReport().sourceInstanceId, 'display-one');
  assert.equal(controller.getRuntimeReport().daily['2026-08-15'], 90000);

  const staleReport = { ...report, daily: { '2026-08-15': 1 } };
  client.emit('message', 'aircon/runtime', Buffer.from(require('node:zlib').gzipSync(JSON.stringify({
    instanceId: 'old-leader',
    version: '2.2.0',
    leaseOwnerId: 'old-owner',
    sequence: 99,
    publishedAt: 3000,
    report: staleReport
  }))));
  assert.equal(controller.getRuntimeReport().daily['2026-08-15'], 90000);
  await controller.stop();
  assert.equal(client.endForce, false);
});

test('failed bridge enablement rolls back and does not poison later transitions', async () => {
  const client = new FakeMqttClient();
  const controller = new MqttController({
    mqttLibrary: { connect: () => client },
    runtimeStore: new FakeRuntimeStore(),
    homeAssistantEnabled: false,
    homeAssistantConfigured: true,
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state'
  });
  await controller.initialize();
  controller.start();
  client.emit('connect');
  controller.setHomeAssistantLeaseState({ role: 'leader', ownerId: 'owner-one' });

  client.subscribeError = new Error('HA subscription denied');
  await assert.rejects(controller.setHomeAssistantEnabled(true), /subscription denied/);
  assert.equal(controller.getSnapshot().homeAssistant.enabled, false);
  assert.equal(controller.getSnapshot().homeAssistant.status, 'error');

  client.subscribeError = null;
  await controller.setHomeAssistantEnabled(true);
  assert.equal(controller.getSnapshot().homeAssistant.enabled, true);
  await controller.setHomeAssistantEnabled(false);
  await controller.stop();
});

test('lease loss fences delayed setup before it can publish online availability', async () => {
  const client = new FakeMqttClient();
  const controller = new MqttController({
    mqttLibrary: { connect: () => client },
    runtimeStore: new FakeRuntimeStore(),
    homeAssistantEnabled: false,
    homeAssistantConfigured: true,
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state'
  });
  await controller.initialize();
  controller.start();
  client.emit('connect');
  controller.setHomeAssistantLeaseState({ role: 'leader', ownerId: 'owner-one' });
  await new Promise((resolve) => setImmediate(resolve));

  client.deferredPublishCallbacks = [];
  const enablePromise = controller.setHomeAssistantEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  const disablePromise = controller.setHomeAssistantEnabled(false);
  client.deferredPublishCallbacks.shift()(null);
  await new Promise((resolve) => setImmediate(resolve));
  client.deferredPublishCallbacks.shift()(null);
  await Promise.all([enablePromise, disablePromise]);

  const availabilityMessages = client.published
    .filter((entry) => entry.topic.endsWith('/availability'))
    .map((entry) => entry.message);
  assert.deepEqual(availabilityMessages, ['offline']);
  client.deferredPublishCallbacks = null;
  await controller.stop();
});

test('a newer disable cancels a stale queued bridge enable', async () => {
  const client = new FakeMqttClient();
  const controller = new MqttController({
    mqttLibrary: { connect: () => client },
    runtimeStore: new FakeRuntimeStore(),
    homeAssistantEnabled: true,
    commandTopic: 'aircon/command',
    stateTopic: 'aircon/state',
    weatherTopic: 'weather/state'
  });
  await controller.initialize();
  controller.start();

  const firstDisable = controller.setHomeAssistantEnabled(false);
  const staleEnable = controller.setHomeAssistantEnabled(true);
  const latestDisable = controller.setHomeAssistantEnabled(false);
  await Promise.all([firstDisable, staleEnable, latestDisable]);

  assert.equal(controller.getSnapshot().homeAssistant.enabled, false);
  assert.equal(client.published.some((entry) => entry.topic.endsWith('/config')), false);
  assert.equal(client.published.some((entry) => entry.message === 'online'), false);
  await controller.stop();
});
