const { EventEmitter } = require('events');
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

  start() {
    if (this.client) return;
    this.stopped = false;
    this.client = this.options.mqttLibrary.connect(
      this.options.brokerUrl,
      this.createConnectOptions(this.options.clientId)
    );
    this.client.on('connect', () => this.observe());
    this.client.on('message', (topic, payload, packet) => this.handleMessage(topic, payload.toString(), packet));
    this.client.on('reconnect', () => this.setState({ role: 'reconnecting' }));
    this.client.on('offline', () => this.handleMonitorLoss('Bridge lease connection is offline'));
    this.client.on('close', () => this.handleMonitorLoss('Bridge lease connection closed'));
    this.client.on('error', (error) => this.setState({ error: error.message }));
  }

  observe() {
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
      this.createConnectOptions(`${this.options.clientId}_guard`, {
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
        this.client.publish(this.options.topic, '', { qos: 1, retain: true }, resolve);
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
    this.clearTimers();
    if (this.leader) {
      this.loseLeadership(reason);
    } else if (this.guardClient) {
      void this.closeGuard(false);
    }
    this.setState({ role: 'disconnected', error: reason });
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
        this.client.publish(this.options.topic, '', { qos: 1, retain: true }, resolve);
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
        this.client.publish(this.options.topic, '', { qos: 1, retain: true }, resolve);
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
    await this.eligibilityTransition.catch(() => {});
    this.clearTimers();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.leader = false;
    await this.closeGuard(true);
    if (this.currentLease?.ownerId === this.options.ownerId && this.client?.connected) {
      await new Promise((resolve) => {
        this.client.publish(this.options.topic, '', { qos: 1, retain: true }, resolve);
      });
    }
    if (this.client) {
      await new Promise((resolve) => this.client.end(false, {}, resolve));
    }
    this.client = null;
  }
}

module.exports = { HomeAssistantLease, parseLease };