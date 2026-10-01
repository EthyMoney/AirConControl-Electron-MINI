const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const mqtt = require('mqtt');

function parseLease(message, now) {
  if (!message) return null;
  try {
    const lease = JSON.parse(message);
    const hasDuration = Number.isFinite(lease.leaseDurationMs) && lease.leaseDurationMs > 0;
    if (typeof lease.ownerId !== 'string' || (!hasDuration && !Number.isFinite(lease.expiresAt))) {
      return { active: true, ownerId: 'unknown' };
    }
    return { ...lease, active: hasDuration || lease.expiresAt > now };
  } catch {
    return { active: true, ownerId: 'unknown' };
  }
}

class HomeAssistantLease extends EventEmitter {
  constructor(options) {
    super();
    this.options = {
      mqttLibrary: mqtt,
      now: () => Date.now(),
      random: Math.random,
      leaseDurationMs: 30000,
      observationMs: 500,
      contentionMs: 500,
      settleMs: 250,
      connectTimeoutMs: 5000,
      clientIdRotationAttempts: 3,
      monitorStableMs: 15000,
      ...options
    };
    this.client = null;
    this.guardClient = null;
    this.currentLease = null;
    this.leader = false;
    this.eligible = options.eligible !== false;
    this.stopped = false;
    this.closingGuard = false;
    this.timers = new Set();
    this.heartbeat = null;
    this.eligibilityTransition = Promise.resolve();
    this.electionNotBefore = 0;
    this.monitorClientId = options.clientId;
    this.monitorReconnectAttempts = 0;
    this.monitorStableTimer = null;
    this.monitorHandlers = {};
    this.pendingMonitorReplacement = null;
    this.state = {
      role: 'starting',
      ownerId: null,
      ownerInstanceId: null,
      expiresAt: null,
      error: null
    };
  }

  getSnapshot() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getSnapshot());
  }

  createConnectOptions(clientId, will) {
    const options = {
      ...this.options.mqttConnectOptions,
      clean: true,
      clientId,
      protocolVersion: 5,
      reconnectPeriod: will ? 0 : 5000,
      connectTimeout: this.options.connectTimeoutMs
    };
    if (this.options.username) options.username = this.options.username;
    if (this.options.password) options.password = this.options.password;
    if (will) options.will = will;
    return options;
  }

  handleMonitorReconnect(client) {
    if (this.stopped || client !== this.client) return;
    this.monitorReconnectAttempts += 1;
    if (this.monitorReconnectAttempts < this.options.clientIdRotationAttempts) {
      this.setState({ role: 'reconnecting', error: this.state.error });
      return;
    }
    // Renaming the client in place is not enough: MQTT.js keeps a client's queued and in-flight
    // packets across reconnects and sends them first, so one unsendable packet fails every
    // reconnect forever. Replace the client with a new one (new identity, empty queues).
    // MQTT.js calls connect() right after emitting 'reconnect', so replace it on the next turn.
    this.monitorReconnectAttempts = 0;
    this.setState({
      role: 'reconnecting',
      error: 'Repeated bridge lease disconnects; reconnecting with a new MQTT client'
    });
    if (this.pendingMonitorReplacement) clearImmediate(this.pendingMonitorReplacement);
    this.pendingMonitorReplacement = setImmediate(() => {
      this.pendingMonitorReplacement = null;
      this.replaceMonitorClient(client);
    });
  }

  replaceMonitorClient(client) {
    if (this.stopped || client !== this.client) return;
    for (const [event, handler] of Object.entries(this.monitorHandlers)) client.removeListener(event, handler);
    client.on('error', () => {});
    client.end(true);
    this.client = null;
    this.monitorClientId = `${this.options.clientId}_recovery_${randomUUID()}`;
    this.connectMonitor();
  }

  scheduleMonitorStability() {
    if (this.monitorStableTimer) clearTimeout(this.monitorStableTimer);
    this.monitorStableTimer = setTimeout(() => {
      this.monitorStableTimer = null;
      this.monitorReconnectAttempts = 0;
    }, this.options.monitorStableMs);
    this.monitorStableTimer.unref?.();
  }

  start() {
    if (this.client) return;
    this.stopped = false;
    this.connectMonitor();
  }

  connectMonitor() {
    const client = this.options.mqttLibrary.connect(
      this.options.brokerUrl,
      this.createConnectOptions(this.monitorClientId)
    );
    // Events from a client that has been replaced or stopped are ignored.
    const current = () => client === this.client && !this.stopped;
    const handlers = {
      connect: () => { if (current()) this.observe(); },
      message: (topic, payload, packet) => { if (current()) this.handleMessage(topic, payload.toString(), packet); },
      reconnect: () => this.handleMonitorReconnect(client),
      offline: () => { if (current()) this.handleMonitorLoss('Bridge lease connection is offline'); },
      close: () => { if (current()) this.handleMonitorLoss('Bridge lease connection closed'); },
      error: (error) => { if (current()) this.setState({ error: error.message }); }
    };
    for (const [event, handler] of Object.entries(handlers)) client.on(event, handler);
    this.client = client;
    this.monitorHandlers = handlers;
  }

  observe() {
    if (this.stopped || !this.client) return;
    this.scheduleMonitorStability();
    this.setState({ role: this.eligible ? 'observing' : 'waiting-for-mqtt', error: null });
    this.client.subscribe(this.options.topic, { qos: 1 }, (error) => {
      if (error) {
        this.setState({ role: 'error', error: error.message });
        return;
      }
      this.scheduleElection(this.options.observationMs);
    });
  }

  handleMessage(topic, message, packet) {
    if (topic !== this.options.topic || this.stopped) return;
    const observedAt = this.options.now();
    const lease = parseLease(message, this.options.now());
    const packetLifetimeMs = Number(packet?.properties?.messageExpiryInterval) * 1000;
    const payloadLifetimeMs = Number(lease?.leaseDurationMs);
    const legacyLifetimeMs = Number(lease?.expiresAt) - observedAt;
    const requestedLifetimeMs = Number.isFinite(packetLifetimeMs) && packetLifetimeMs > 0
      ? packetLifetimeMs
      : (Number.isFinite(payloadLifetimeMs) && payloadLifetimeMs > 0
          ? payloadLifetimeMs
          : legacyLifetimeMs);
    const lifetimeMs = Number.isFinite(requestedLifetimeMs) && requestedLifetimeMs > 0
      ? Math.min(requestedLifetimeMs, this.options.leaseDurationMs)
      : (lease?.ownerId === 'unknown' ? this.options.leaseDurationMs : 0);
    this.currentLease = lease?.active && lifetimeMs > 0
      ? { ...lease, localExpiresAt: observedAt + lifetimeMs }
      : null;
    if (!this.currentLease) {
      if (!this.leader) this.scheduleElection(0);
      return;
    }
    if (this.currentLease.ownerId === this.options.ownerId) {
      if (!this.leader && this.state.role !== 'claiming') this.scheduleElection(0);
      this.setState({
        ownerId: this.currentLease.ownerId,
        ownerInstanceId: this.currentLease.instanceId || null,
        expiresAt: this.currentLease.localExpiresAt
      });
      return;
    }
    const wasLeader = this.leader;
    this.leader = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const guardClosed = this.closeGuard(wasLeader);
    this.clearTimers();
    this.setState({
      role: this.eligible ? 'standby' : 'waiting-for-mqtt',
      ownerId: this.currentLease.ownerId,
      ownerInstanceId: this.currentLease.instanceId || null,
      expiresAt: this.currentLease.localExpiresAt,
      error: this.eligible ? null : 'Controller MQTT connection is not ready'
    });
    if (wasLeader) this.emit('lost', this.getSnapshot());
    const remainingMs = Math.max(0, this.currentLease.localExpiresAt - this.options.now());
    guardClosed.finally(() => this.scheduleElection(remainingMs));
  }

  scheduleElection(delayMs) {
    if (this.stopped || !this.eligible || this.leader || !this.client?.connected) return;
    this.clearTimers();
    const jitterMs = Math.floor(this.options.random() * this.options.contentionMs);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const activeForeignLease = this.currentLease?.active
        && this.currentLease.ownerId !== this.options.ownerId
        && this.currentLease.localExpiresAt > this.options.now();
      if (activeForeignLease) {
        this.scheduleElection(this.currentLease.localExpiresAt - this.options.now());
        return;
      }
      this.claim();
    }, Math.max(0, delayMs, this.electionNotBefore - this.options.now()) + jitterMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  claim() {
    if (this.stopped || !this.eligible || this.leader || !this.client?.connected) return;
    this.setState({ role: 'claiming', error: null });
    this.publishLease((error) => {
      if (error) {
        this.setState({ role: 'error', error: error.message });
        this.scheduleElection(this.options.leaseDurationMs);
        return;
      }
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.currentLease?.ownerId === this.options.ownerId) this.openGuard();
        else this.scheduleElection(this.options.leaseDurationMs);
      }, this.options.settleMs);
      timer.unref?.();
      this.timers.add(timer);
    });
  }

  buildPayload() {
    return JSON.stringify({
      ownerId: this.options.ownerId,
      instanceId: this.options.instanceId,
      hostname: this.options.hostname,
      version: this.options.version,
      leaseDurationMs: this.options.leaseDurationMs,
      expiresAt: this.options.now() + this.options.leaseDurationMs
    });
  }

  // A released lease is published as an already-expired lease, never as an empty retained message.
  // Electron 43 on the Raspberry Pi (arm64) cannot write zero-length buffers: writev fails with
  // EFAULT, and MQTT.js retries the unsent QoS 1 publish first after every reconnect, so a single
  // empty release kept the lease client failing on every reconnect for days. parseLease() in every
  // version treats a lease without leaseDurationMs whose expiresAt is in the past as inactive.
  buildReleasePayload() {
    return JSON.stringify({
      ownerId: this.options.ownerId,
      instanceId: this.options.instanceId,
      hostname: this.options.hostname,
      version: this.options.version,
      released: true,
      expiresAt: 0
    });
  }

  publishRelease(callback = () => {}) {
    this.client.publish(this.options.topic, this.buildReleasePayload(), {
      qos: 1,
      retain: true,
      properties: { messageExpiryInterval: Math.ceil(this.options.leaseDurationMs / 1000) }
    }, callback);
  }

  publishLease(callback = () => {}) {
    this.client.publish(this.options.topic, this.buildPayload(), {
      qos: 1,
      retain: true,
      properties: { messageExpiryInterval: Math.ceil(this.options.leaseDurationMs / 1000) }
    }, callback);
  }

  openGuard() {
    if (this.guardClient) {
      if (this.closingGuard) {
        const closingGuard = this.guardClient;
        closingGuard.once('close', () => this.scheduleElection(0));
      }
      return;
    }
    if (this.stopped || !this.eligible || !this.client?.connected) return;
    this.closingGuard = false;
    const guard = this.options.mqttLibrary.connect(
      this.options.brokerUrl,
      this.createConnectOptions(`${this.monitorClientId}_guard`, {
        topic: this.options.availabilityTopic,
        payload: 'offline',
        qos: 1,
        retain: true
      })
    );
    this.guardClient = guard;
    guard.once('connect', () => {
      const stillOwnsLease = this.currentLease?.ownerId === this.options.ownerId;
      const leaseIsLive = Number(this.currentLease?.localExpiresAt) > this.options.now();
      if (
        this.stopped
        || !this.eligible
        || !this.client?.connected
        || this.closingGuard
        || this.guardClient !== guard
        || !stillOwnsLease
        || !leaseIsLive
      ) {
        if (this.guardClient === guard && !this.closingGuard) {
          this.closeGuard(false).finally(() => this.scheduleElection(0));
        }
        return;
      }
      this.leader = true;
      this.startHeartbeat();
      this.setState({ role: 'leader', error: null });
      this.emit('acquired', this.getSnapshot());
    });
    guard.on('error', (error) => {
      if (!this.leader) this.setState({ role: 'error', error: error.message });
    });
    guard.on('close', () => {
      if (this.guardClient !== guard) return;
      const expectedClose = this.closingGuard;
      this.guardClient = null;
      this.closingGuard = false;
      if (!expectedClose && !this.stopped) {
        void this.handleUnexpectedGuardClose('Bridge availability guard disconnected');
      }
    });
  }

  async handleUnexpectedGuardClose(reason) {
    const wasLeader = this.leader;
    this.leader = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.currentLease?.ownerId === this.options.ownerId && this.client?.connected) {
      await new Promise((resolve) => {
        this.publishRelease(resolve);
      });
      this.currentLease = null;
    }
    this.setState({ role: 'standby', error: reason });
    if (wasLeader) this.emit('lost', this.getSnapshot());
    this.scheduleElection(0);
  }

  startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.client?.connected) {
        this.publishLease((error) => {
          if (error) this.loseLeadership(`Failed to refresh bridge lease: ${error.message}`);
        });
      }
    }, Math.max(1000, Math.floor(this.options.leaseDurationMs / 3)));
    this.heartbeat.unref?.();
  }

  handleMonitorLoss(reason) {
    if (this.stopped) return;
    if (this.monitorStableTimer) clearTimeout(this.monitorStableTimer);
    this.monitorStableTimer = null;
    const error = this.state.error || reason;
    this.clearTimers();
    if (this.leader) {
      this.loseLeadership(error);
    } else if (this.guardClient) {
      void this.closeGuard(false);
    }
    this.setState({ role: 'disconnected', error });
  }

  loseLeadership(reason) {
    if (!this.leader && !this.guardClient) return;
    const wasLeader = this.leader;
    this.leader = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const guardClosed = this.closeGuard(true);
    this.setState({ role: 'standby', error: reason });
    if (wasLeader) this.emit('lost', this.getSnapshot());
    guardClosed.finally(() => this.scheduleElection(0));
  }

  closeGuard(publishOffline) {
    const guard = this.guardClient;
    if (!guard) return Promise.resolve();
    this.closingGuard = true;
    return new Promise((resolve) => {
      guard.once('close', resolve);
      const close = () => guard.end(false);
      if (publishOffline && guard.connected) {
        guard.publish(this.options.availabilityTopic, 'offline', { qos: 1, retain: true }, close);
      } else {
        close();
      }
    });
  }

  setEligible(eligible) {
    const transition = this.eligibilityTransition
      .catch(() => {})
      .then(() => this.applyEligibility(Boolean(eligible)));
    this.eligibilityTransition = transition.catch(() => {});
    return transition;
  }

  async applyEligibility(nextEligible) {
    if (this.stopped) return;
    if (this.eligible === nextEligible) return;
    this.eligible = nextEligible;
    if (nextEligible) {
      this.electionNotBefore = 0;
      this.setState({ role: 'observing', error: null });
      this.scheduleElection(this.options.observationMs);
      return;
    }

    this.clearTimers();
    const wasLeader = this.leader;
    this.leader = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.closeGuard(true);
    if (this.currentLease?.ownerId === this.options.ownerId && this.client?.connected) {
      await new Promise((resolve) => {
        this.publishRelease(resolve);
      });
      this.currentLease = null;
    }
    this.setState({
      role: 'waiting-for-mqtt',
      ownerId: null,
      ownerInstanceId: null,
      expiresAt: null,
      error: 'Controller MQTT connection is not ready'
    });
    if (wasLeader) this.emit('lost', this.getSnapshot());
  }

  yieldLeadership(reason) {
    const transition = this.eligibilityTransition
      .catch(() => {})
      .then(() => this.applyLeadershipYield(reason));
    this.eligibilityTransition = transition.catch(() => {});
    return transition;
  }

  async applyLeadershipYield(reason) {
    if (this.stopped) return;
    this.electionNotBefore = this.options.now() + this.options.leaseDurationMs;
    this.clearTimers();
    const wasLeader = this.leader;
    this.leader = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.closeGuard(true);
    if (this.currentLease?.ownerId === this.options.ownerId && this.client?.connected) {
      await new Promise((resolve) => {
        this.publishRelease(resolve);
      });
    }
    this.currentLease = null;
    this.setState({
      role: 'standby',
      ownerId: null,
      ownerInstanceId: null,
      expiresAt: null,
      error: reason
    });
    if (wasLeader) this.emit('lost', this.getSnapshot());
    this.scheduleElection(this.options.leaseDurationMs);
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async stop() {
    this.stopped = true;
    this.eligible = false;
    if (this.pendingMonitorReplacement) clearImmediate(this.pendingMonitorReplacement);
    this.pendingMonitorReplacement = null;
    await this.eligibilityTransition.catch(() => {});
    this.clearTimers();
    if (this.monitorStableTimer) clearTimeout(this.monitorStableTimer);
    this.monitorStableTimer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.leader = false;
    await this.closeGuard(true);
    if (this.currentLease?.ownerId === this.options.ownerId && this.client?.connected) {
      await new Promise((resolve) => {
        this.publishRelease(resolve);
      });
    }
    if (this.client) {
      await new Promise((resolve) => this.client.end(false, {}, resolve));
    }
    this.client = null;
  }
}

module.exports = { HomeAssistantLease, parseLease };
