const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { HomeAssistantLease, parseLease } = require('../home-assistant-lease');

class FakeBroker {
  constructor() {
    this.retained = new Map();
    this.clients = [];
    this.guardConnectDelayMs = 0;
    this.guardEndDelayMs = 0;
    this.failNextGuard = false;
  }

  connect(_url, options) {
    const client = new FakeMqttClient(this, options);
    this.clients.push(client);
    if (options.will && this.failNextGuard) {
      this.failNextGuard = false;
      setImmediate(() => client.end(false, {}, () => {}));
    } else if (options.will && this.guardConnectDelayMs > 0) {
      setTimeout(() => {
        if (client.connected && !client.ending) client.emit('connect');
      }, this.guardConnectDelayMs);
    } else {
      setImmediate(() => client.emit('connect'));
    }
    return client;
  }

  publish(topic, message, options, callback) {
    if (options.retain) {
      if (message) this.retained.set(topic, message);
      else this.retained.delete(topic);
    }
    setImmediate(() => {
      callback?.(null);
      for (const client of this.clients) {
        if (client.connected && client.subscriptions.has(topic)) {
          client.emit('message', topic, Buffer.from(message));
        }
      }
    });
  }
}

class FakeMqttClient extends EventEmitter {
  constructor(broker, options) {
    super();
    this.broker = broker;
    this.options = options;
    this.connected = true;
    this.subscriptions = new Set();
  }

  subscribe(topic, _options, callback) {
    this.subscriptions.add(topic);
    callback(null);
    const retained = this.broker.retained.get(topic);
    if (retained) setImmediate(() => this.emit('message', topic, Buffer.from(retained)));
  }

  publish(topic, message, options, callback) {
    this.broker.publish(topic, message, options, callback);
  }

  end(force, _options, callback) {
    this.endForce = force;
    this.ending = true;
    const finish = () => {
      this.connected = false;
      callback?.();
      setImmediate(() => this.emit('close'));
    };
    if (this.options.will && this.broker.guardEndDelayMs > 0) {
      setTimeout(finish, this.broker.guardEndDelayMs);
    } else {
      finish();
    }
  }
}

function createLease(broker, ownerId, instanceId, overrides = {}) {
  return new HomeAssistantLease({
    brokerUrl: 'mqtt://test',
    clientId: `${ownerId}-client`,
    ownerId,
    instanceId,
    hostname: instanceId,
    version: '1.2.3',
    topic: 'airconcontrol/shop/bridge/owner',
    availabilityTopic: 'airconcontrol/shop/availability',
    mqttConnectOptions: { ca: Buffer.from('test-ca'), rejectUnauthorized: true },
    mqttLibrary: broker,
    observationMs: 10,
    contentionMs: 0,
    settleMs: 5,
    leaseDurationMs: 40,
    ...overrides
  });
}

test('recognizes live, expired, and malformed retained leases', () => {
  assert.equal(parseLease(JSON.stringify({ ownerId: 'one', expiresAt: 2000 }), 1000).active, true);
  assert.equal(parseLease(JSON.stringify({ ownerId: 'one', expiresAt: 500 }), 1000).active, false);
  assert.equal(parseLease('invalid', 1000).active, true);
  assert.equal(parseLease('', 1000), null);
});

test('elects one bridge and keeps another network instance on standby', async () => {
  const broker = new FakeBroker();
  const first = createLease(broker, 'owner-one', 'display-one');
  first.start();
  await once(first, 'acquired');

  const second = createLease(broker, 'owner-two', 'display-two');
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(first.getSnapshot().role, 'leader');
  assert.equal(second.getSnapshot().role, 'standby');
  assert.equal(second.getSnapshot().ownerInstanceId, 'display-one');
  assert.equal(broker.clients.some((client) => client.options.protocolVersion === 5), true);
  assert.equal(broker.clients.every((client) => client.options.ca.toString() === 'test-ca'), true);
  assert.equal(broker.clients.some((client) => client.options.will?.topic === 'airconcontrol/shop/availability'), true);

  await first.stop();
  await second.stop();
});

test('standby automatically takes over when the leader releases its lease', async () => {
  const broker = new FakeBroker();
  const first = createLease(broker, 'owner-one', 'display-one');
  const second = createLease(broker, 'owner-two', 'display-two');
  first.start();
  await once(first, 'acquired');
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const acquired = once(second, 'acquired');
  await first.stop();
  await acquired;

  assert.equal(second.getSnapshot().role, 'leader');
  assert.equal(second.getSnapshot().ownerInstanceId, 'display-two');
  await second.stop();
});

test('a leader with an unhealthy controller connection yields to a standby', async () => {
  const broker = new FakeBroker();
  const first = createLease(broker, 'owner-one', 'display-one');
  const second = createLease(broker, 'owner-two', 'display-two');
  first.start();
  await once(first, 'acquired');
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const acquired = once(second, 'acquired');
  await first.setEligible(false);
  await acquired;

  assert.equal(first.getSnapshot().role, 'waiting-for-mqtt');
  assert.equal(second.getSnapshot().role, 'leader');
  assert.equal(broker.retained.get('airconcontrol/shop/availability'), 'offline');
  await first.stop();
  await second.stop();
});

test('lease lifetime does not depend on synchronized device clocks', async () => {
  const broker = new FakeBroker();
  const first = createLease(broker, 'owner-one', 'display-one', {
    now: () => Date.now() - 3600000
  });
  const second = createLease(broker, 'owner-two', 'display-two', {
    now: () => Date.now() + 3600000
  });
  first.start();
  await once(first, 'acquired');
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(first.getSnapshot().role, 'leader');
  assert.equal(second.getSnapshot().role, 'standby');
  await first.stop();
  await second.stop();
});

test('rapid eligibility changes are applied in order', async () => {
  const broker = new FakeBroker();
  const lease = createLease(broker, 'owner-one', 'display-one');
  lease.start();
  await once(lease, 'acquired');
  const reacquired = once(lease, 'acquired');

  const disabled = lease.setEligible(false);
  const enabled = lease.setEligible(true);
  await Promise.all([disabled, enabled]);
  await reacquired;

  assert.equal(lease.getSnapshot().role, 'leader');
  await lease.stop();
  assert.equal(broker.clients.every((client) => client.endForce === false), true);
});

test('a bridge setup failure yields the lease to a healthy standby', async () => {
  const broker = new FakeBroker();
  const first = createLease(broker, 'owner-one', 'display-one');
  const second = createLease(broker, 'owner-two', 'display-two');
  first.start();
  await once(first, 'acquired');
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const acquired = once(second, 'acquired');
  await first.yieldLeadership('Bridge setup failed');
  await acquired;

  assert.equal(first.getSnapshot().role, 'standby');
  assert.equal(second.getSnapshot().role, 'leader');
  await first.stop();
  await second.stop();
});

test('a pending guard cannot become leader after a foreign lease arrives', async () => {
  const broker = new FakeBroker();
  broker.guardConnectDelayMs = 40;
  const lease = createLease(broker, 'owner-one', 'display-one');
  let acquiredCount = 0;
  lease.on('acquired', () => { acquiredCount += 1; });
  lease.start();
  await new Promise((resolve) => setTimeout(resolve, 25));

  broker.publish(
    'airconcontrol/shop/bridge/owner',
    JSON.stringify({
      ownerId: 'foreign-owner',
      instanceId: 'display-two',
      leaseDurationMs: 100,
      expiresAt: Date.now() + 100
    }),
    { qos: 1, retain: true },
    () => {}
  );
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(acquiredCount, 0);
  assert.equal(lease.getSnapshot().role, 'standby');
  assert.equal(lease.getSnapshot().ownerInstanceId, 'display-two');
  await lease.stop();
});

test('guard failure before leadership clears the self lease and retries', async () => {
  const broker = new FakeBroker();
  broker.failNextGuard = true;
  const lease = createLease(broker, 'owner-one', 'display-one');
  lease.start();
  await once(lease, 'acquired');

  assert.equal(lease.getSnapshot().role, 'leader');
  assert.ok(broker.clients.filter((client) => client.options.will).length >= 2);
  await lease.stop();
});

test('re-election waits for an expected pending-guard close', async () => {
  const broker = new FakeBroker();
  broker.guardConnectDelayMs = 100;
  broker.guardEndDelayMs = 70;
  const lease = createLease(broker, 'owner-one', 'display-one');
  lease.start();
  await new Promise((resolve) => setTimeout(resolve, 25));

  broker.guardConnectDelayMs = 0;
  broker.publish(
    'airconcontrol/shop/bridge/owner',
    JSON.stringify({
      ownerId: 'foreign-owner',
      instanceId: 'display-two',
      leaseDurationMs: 20,
      expiresAt: Date.now() + 20
    }),
    { qos: 1, retain: true },
    () => {}
  );

  await once(lease, 'acquired');
  assert.equal(lease.getSnapshot().role, 'leader');
  assert.ok(broker.clients.filter((client) => client.options.will).length >= 2);
  await lease.stop();
});

test('a pending guard cannot promote after the lease monitor disconnects', async () => {
  const broker = new FakeBroker();
  broker.guardConnectDelayMs = 60;
  const lease = createLease(broker, 'owner-one', 'display-one');
  let acquiredCount = 0;
  lease.on('acquired', () => { acquiredCount += 1; });
  lease.start();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const monitor = broker.clients.find((client) => !client.options.will);
  monitor.connected = false;
  monitor.emit('offline');
  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal(acquiredCount, 0);
  assert.equal(lease.getSnapshot().role, 'disconnected');
  await lease.stop();
});

test('repeated monitor reconnects rotate the MQTT client identity', async () => {
  const broker = new FakeBroker();
  const lease = createLease(broker, 'owner-one', 'display-one');
  lease.start();
  const monitor = broker.clients[0];
  const initialClientId = monitor.options.clientId;

  monitor.emit('reconnect');
  monitor.emit('reconnect');
  assert.equal(monitor.options.clientId, initialClientId);
  monitor.emit('reconnect');

  assert.notEqual(monitor.options.clientId, initialClientId);
  assert.match(monitor.options.clientId, /^owner-one-client_recovery_/);
  await new Promise((resolve) => setImmediate(resolve));
  await lease.stop();
});

test('monitor disconnect preserves the specific MQTT error', async () => {
  const broker = new FakeBroker();
  const lease = createLease(broker, 'owner-one', 'display-one');
  lease.start();
  await once(lease, 'acquired');
  const monitor = broker.clients.find((client) => !client.options.will);

  monitor.emit('error', new Error('Connection refused: identifier rejected'));
  monitor.connected = false;
  monitor.emit('offline');

  assert.equal(lease.getSnapshot().role, 'disconnected');
  assert.equal(lease.getSnapshot().error, 'Connection refused: identifier rejected');
  await lease.stop();
});

test('a pending guard cannot promote after its local lease expires', async () => {
  const broker = new FakeBroker();
  broker.guardConnectDelayMs = 70;
  const lease = createLease(broker, 'owner-one', 'display-one');
  let acquiredCount = 0;
  lease.on('acquired', () => { acquiredCount += 1; });
  lease.start();
  await new Promise((resolve) => setTimeout(resolve, 65));

  assert.equal(acquiredCount, 0);
  broker.guardConnectDelayMs = 0;
  await once(lease, 'acquired');
  assert.equal(lease.getSnapshot().role, 'leader');
  await lease.stop();
});
