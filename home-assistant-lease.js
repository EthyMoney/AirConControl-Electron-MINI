const mqtt = require('mqtt');

function parseLease(message, now) {
  if (!message) {
    return null;
  }
  try {
    const lease = JSON.parse(message);
    if (typeof lease.ownerId !== 'string' || !Number.isFinite(lease.expiresAt)) {
      return { active: true, ownerId: 'unknown' };
    }
    return { ...lease, active: lease.expiresAt > now };
  } catch {
    return { active: true, ownerId: 'unknown' };
  }
}

function acquireHomeAssistantLease(options) {
  const {
    brokerUrl,
    clientId,
    ownerId,
    topic,
    username,
    password,
    mqttLibrary = mqtt,
    now = () => Date.now(),
    leaseDurationMs = 30000,
    observationMs = 500,
    contentionMs = 500,
    settleMs = 250,
    connectTimeoutMs = 5000,
    random = Math.random
  } = options;

  return new Promise((resolve) => {
    let acquired = false;
    let finished = false;
    let currentOwnerId = null;
    let claimTimer = null;
    let settleTimer = null;
    let heartbeat = null;

    const connectOptions = {
      clean: true,
      clientId,
      reconnectPeriod: 0,
      connectTimeout: connectTimeoutMs
    };
    if (username) connectOptions.username = username;
    if (password) connectOptions.password = password;
    const client = mqttLibrary.connect(brokerUrl, connectOptions);

    const clearDecisionTimers = () => {
      if (claimTimer) clearTimeout(claimTimer);
      if (settleTimer) clearTimeout(settleTimer);
      claimTimer = null;
      settleTimer = null;
    };

    const publishLease = (callback = () => {}) => {
      const payload = JSON.stringify({ ownerId, expiresAt: now() + leaseDurationMs });
      client.publish(topic, payload, { qos: 1, retain: true }, callback);
    };

    const finish = (didAcquire, reason) => {
      if (finished) return;
      finished = true;
      acquired = didAcquire;
      clearDecisionTimers();

      if (didAcquire) {
        heartbeat = setInterval(() => {
          if (client.connected) publishLease();
        }, Math.max(1000, Math.floor(leaseDurationMs / 3)));
        heartbeat.unref?.();
      } else {
        client.end(true);
      }

      resolve({
        acquired: didAcquire,
        reason,
        release: () => new Promise((releaseResolve) => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
          if (!acquired || !client.connected || currentOwnerId !== ownerId) {
            client.end(true);
            releaseResolve();
            return;
          }
          client.publish(topic, '', { qos: 1, retain: true }, () => {
            acquired = false;
            client.end(true);
            releaseResolve();
          });
        })
      });
    };

    const claim = () => {
      claimTimer = null;
      publishLease((error) => {
        if (error) {
          finish(false, `Unable to claim bridge lease: ${error.message}`);
          return;
        }
        settleTimer = setTimeout(() => {
          settleTimer = null;
          finish(currentOwnerId === ownerId, currentOwnerId === ownerId
            ? null
            : 'Another instance won the bridge lease');
        }, settleMs);
      });
    };

    client.on('message', (messageTopic, messageBuffer) => {
      if (messageTopic !== topic) return;
      const lease = parseLease(messageBuffer.toString(), now());
      currentOwnerId = lease?.active ? lease.ownerId : null;
      if (!finished && lease?.active && lease.ownerId !== ownerId) {
        finish(false, 'Another instance already owns the Home Assistant bridge lease');
      }
    });
    client.on('connect', () => {
      client.subscribe(topic, { qos: 1 }, (error) => {
        if (error) {
          finish(false, `Unable to observe bridge lease: ${error.message}`);
          return;
        }
        const jitterMs = Math.floor(random() * contentionMs);
        claimTimer = setTimeout(claim, observationMs + jitterMs);
      });
    });
    client.on('error', (error) => finish(false, `Unable to coordinate bridge lease: ${error.message}`));
  });
}

module.exports = { acquireHomeAssistantLease, parseLease };