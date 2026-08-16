const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { acquireHomeAssistantLease, parseLease } = require('../home-assistant-lease');

class FakeMqttClient extends EventEmitter {
  constructor(retainedMessage = null) {
    super();
    this.connected = true;
    this.retainedMessage = retainedMessage;
    this.published = [];
    setImmediate(() => this.emit('connect'));
  }

  subscribe(topic, _options, callback) {
    callback(null);
    if (this.retainedMessage) {
      setImmediate(() => this.emit('message', topic, Buffer.from(this.retainedMessage)));
    }
  }

  publish(topic, message, options, callback = () => {}) {
    this.published.push({ topic, message, options });
    setImmediate(() => {
      callback(null);
      this.emit('message', topic, Buffer.from(message));
    });
  }

  end() {
    this.connected = false;
  }
}

function acquireWithClient(client, overrides = {}) {
  return acquireHomeAssistantLease({
    brokerUrl: 'mqtt://test',
    clientId: 'candidate-client',
    ownerId: 'candidate-owner',
    topic: 'airconcontrol/shop/bridge/owner',
    mqttLibrary: { connect: () => client },
    observationMs: 20,
    contentionMs: 0,
    settleMs: 5,
    leaseDurationMs: 60000,
    ...overrides
  });
}

test('recognizes live, expired, and malformed retained leases', () => {
  assert.equal(parseLease(JSON.stringify({ ownerId: 'one', expiresAt: 2000 }), 1000).active, true);
  assert.equal(parseLease(JSON.stringify({ ownerId: 'one', expiresAt: 500 }), 1000).active, false);
  assert.equal(parseLease('invalid', 1000).active, true);
  assert.equal(parseLease('', 1000), null);
});

test('does not acquire while another network instance has a live lease', async () => {
  const client = new FakeMqttClient(JSON.stringify({ ownerId: 'existing-owner', expiresAt: Date.now() + 60000 }));
  const lease = await acquireWithClient(client);

  assert.equal(lease.acquired, false);
  assert.match(lease.reason, /already owns/);
  assert.equal(client.published.length, 0);
});

test('claims an available lease and clears it when released', async () => {
  const client = new FakeMqttClient();
  const lease = await acquireWithClient(client);

  assert.equal(lease.acquired, true);
  assert.equal(JSON.parse(client.published[0].message).ownerId, 'candidate-owner');
  assert.equal(client.published[0].options.retain, true);

  await lease.release();
  assert.equal(client.published.at(-1).message, '');
  assert.equal(client.connected, false);
});