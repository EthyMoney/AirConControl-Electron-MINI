const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 2;
const MAX_RECORDED_GAPS = 100;

function createEmptyData() {
  return {
    version: STORE_VERSION,
    daily: {},
    hourly: {},
    tracker: {
      cooling: null,
      receivedAt: null
    },
    gaps: []
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeNumberMap(value) {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const numberValue = Number(rawValue);
    if (Number.isFinite(numberValue) && numberValue >= 0) {
      sanitized[key] = Math.floor(numberValue);
    }
  }
  return sanitized;
}

function sanitizeHourlyMap(value) {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized = {};
  for (const [dayKey, hours] of Object.entries(value)) {
    const sanitizedHours = sanitizeNumberMap(hours);
    if (Object.keys(sanitizedHours).length > 0) {
      sanitized[dayKey] = sanitizedHours;
    }
  }
  return sanitized;
}

function sanitizeStoredData(value) {
  if (!isRecord(value)) {
    throw new Error('Runtime store must contain a JSON object');
  }

  const data = createEmptyData();
  data.daily = sanitizeNumberMap(value.daily);
  data.hourly = sanitizeHourlyMap(value.hourly);

  if (isRecord(value.tracker)) {
    data.tracker.cooling = typeof value.tracker.cooling === 'boolean' ? value.tracker.cooling : null;
    data.tracker.receivedAt = Number.isFinite(value.tracker.receivedAt) ? value.tracker.receivedAt : null;
  }

  if (Array.isArray(value.gaps)) {
    data.gaps = value.gaps
      .filter((gap) => isRecord(gap) && Number.isFinite(gap.from) && Number.isFinite(gap.to) && gap.to > gap.from)
      .slice(-MAX_RECORDED_GAPS)
      .map((gap) => ({
        from: gap.from,
        to: gap.to,
        reason: typeof gap.reason === 'string' ? gap.reason : 'unknown'
      }));
  }

  return data;
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addRuntimeInterval(target, fromTimestampMs, toTimestampMs) {
  if (!Number.isFinite(fromTimestampMs) || !Number.isFinite(toTimestampMs) || toTimestampMs <= fromTimestampMs) {
    return;
  }

  let cursor = fromTimestampMs;
  while (cursor < toTimestampMs) {
    const currentDate = new Date(cursor);
    const dayKey = getDayKey(currentDate);
    const hourKey = String(currentDate.getHours());
    const nextHour = new Date(cursor);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);

    const sliceEnd = Math.min(toTimestampMs, nextHour.getTime());
    const sliceMs = Math.max(0, sliceEnd - cursor);
    if (sliceMs <= 0) {
      break;
    }

    target.daily[dayKey] = Number(target.daily[dayKey] || 0) + sliceMs;
    if (!isRecord(target.hourly[dayKey])) {
      target.hourly[dayKey] = {};
    }
    target.hourly[dayKey][hourKey] = Number(target.hourly[dayKey][hourKey] || 0) + sliceMs;
    cursor = sliceEnd;
  }
}

class RuntimeStore extends EventEmitter {
  constructor({
    filePath,
    legacyDailyPath = null,
    legacyHourlyPath = null,
    maxObservationGapMs = 300000,
    now = () => Date.now(),
    saveDelayMs = 250
  }) {
    super();
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.legacyDailyPath = legacyDailyPath;
    this.legacyHourlyPath = legacyHourlyPath;
    this.maxObservationGapMs = maxObservationGapMs;
    this.now = now;
    this.saveDelayMs = saveDelayMs;
    this.data = createEmptyData();
    this.saveTimer = null;
    this.writeChain = Promise.resolve();
    this.dirty = false;
    this.initialized = false;
    this.loadWarning = null;
    this.skipBackupOnce = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      this.data = await this.readStoreFile(this.filePath);
    } catch (primaryError) {
      if (primaryError.code === 'ENOENT') {
        try {
          this.data = await this.readStoreFile(this.backupPath);
          this.loadWarning = 'The primary runtime store was missing; restored its backup';
          this.skipBackupOnce = true;
        } catch (_backupError) {
          await this.importLegacyData();
        }
      } else {
        this.loadWarning = `Runtime data was unreadable: ${primaryError.message}`;
        await this.preserveCorruptFile(this.filePath);

        try {
          this.data = await this.readStoreFile(this.backupPath);
          this.loadWarning += '; restored the last backup';
          this.skipBackupOnce = true;
        } catch (_backupError) {
          this.data = createEmptyData();
          this.loadWarning += '; started a new report while preserving the corrupt file';
        }
      }
    }

    this.initialized = true;
    if (this.loadWarning) {
      this.emit('warning', this.loadWarning);
    }
    this.scheduleSave();
  }

  async readStoreFile(filePath) {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return sanitizeStoredData(JSON.parse(content));
  }

  async readLegacyMap(filePath, hourly = false) {
    if (!filePath) {
      return {};
    }

    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      return hourly ? sanitizeHourlyMap(parsed) : sanitizeNumberMap(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.loadWarning = `Legacy runtime data could not be imported: ${error.message}`;
      }
      return {};
    }
  }

  async importLegacyData() {
    const [daily, hourly] = await Promise.all([
      this.readLegacyMap(this.legacyDailyPath, false),
      this.readLegacyMap(this.legacyHourlyPath, true)
    ]);

    this.data = createEmptyData();
    this.data.daily = daily;
    this.data.hourly = hourly;
  }

  async preserveCorruptFile(filePath) {
    try {
      const preservedPath = `${filePath}.corrupt-${this.now()}`;
      await fs.promises.copyFile(filePath, preservedPath);
    } catch (_error) {
      // The original remains in place if it cannot be copied.
    }
  }

  addGap(from, to, reason) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return;
    }

    this.data.gaps.push({ from, to, reason });
    this.data.gaps = this.data.gaps.slice(-MAX_RECORDED_GAPS);
  }

  recordObservation({ cooling, receivedAt = this.now() }) {
    if (typeof cooling !== 'boolean' || !Number.isFinite(receivedAt)) {
      throw new Error('A runtime observation requires a boolean cooling state and timestamp');
    }

    const previous = this.data.tracker;
    if (Number.isFinite(previous.receivedAt)) {
      const elapsedMs = receivedAt - previous.receivedAt;

      if (elapsedMs < 0) {
        this.addGap(receivedAt, previous.receivedAt, 'system-clock-moved-backward');
      } else if (elapsedMs > 0) {
        const trustedEnd = Math.min(receivedAt, previous.receivedAt + this.maxObservationGapMs);
        if (previous.cooling === true) {
          addRuntimeInterval(this.data, previous.receivedAt, trustedEnd);
        }

        if (elapsedMs > this.maxObservationGapMs) {
          this.addGap(trustedEnd, receivedAt, 'status-not-observed');
        }
      }
    }

    this.data.tracker = { cooling, receivedAt };
    this.scheduleSave();
  }

  getReport() {
    const reportData = cloneData(this.data);
    const now = this.now();

    if (Number.isFinite(reportData.tracker.receivedAt)) {
      const liveEnd = Math.min(now, reportData.tracker.receivedAt + this.maxObservationGapMs);
      if (reportData.tracker.cooling === true) {
        addRuntimeInterval(reportData, reportData.tracker.receivedAt, liveEnd);
      }
      if (now > liveEnd) {
        reportData.gaps.push({ from: liveEnd, to: now, reason: 'status-not-observed' });
        reportData.gaps = reportData.gaps.slice(-MAX_RECORDED_GAPS);
      }
    }

    return {
      generatedAt: now,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      source: 'validated status intervals',
      daily: reportData.daily,
      hourly: reportData.hourly,
      gaps: reportData.gaps,
      warning: this.loadWarning
    };
  }

  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) {
      return;
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.queueWrite();
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  queueWrite() {
    if (!this.dirty) {
      return;
    }

    this.dirty = false;
    const serialized = `${JSON.stringify(this.data, null, 2)}\n`;
    this.writeChain = this.writeChain
      .then(() => this.atomicWrite(serialized))
      .catch((error) => {
        this.emit('error', error);
      });
  }

  async atomicWrite(content) {
    const temporaryPath = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, content, 'utf8');

    try {
      if (this.skipBackupOnce) {
        this.skipBackupOnce = false;
      } else {
        try {
          await fs.promises.copyFile(this.filePath, this.backupPath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      await fs.promises.rename(temporaryPath, this.filePath);
    } catch (error) {
      try {
        await fs.promises.unlink(temporaryPath);
      } catch (_cleanupError) {
        // Best-effort cleanup; the original exception is more useful.
      }
      throw error;
    }
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.queueWrite();
    await this.writeChain;
  }
}

module.exports = {
  RuntimeStore,
  addRuntimeInterval,
  createEmptyData,
  getDayKey,
  sanitizeStoredData
};
