const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 3;
const MAX_RECORDED_GAPS = 100;
const TEMPERATURE_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TEMPERATURE_SAMPLES_PER_DAY = 400;
const DETAILED_HISTORY_RETENTION_DAYS = 90;

function createEmptyData() {
  return {
    version: STORE_VERSION,
    daily: {},
    hourly: {},
    tracker: {
      cooling: null,
      receivedAt: null
    },
    gaps: [],
    temperatureHistory: {},
    coolingIntervals: {}
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

function sanitizeTemperatureHistory(value) {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized = {};
  for (const [dayKey, rawSamples] of Object.entries(value)) {
    if (!Array.isArray(rawSamples)) {
      continue;
    }

    const samples = rawSamples
      .filter((sample) => isRecord(sample))
      .map((sample) => ({ at: Number(sample.at), value: Number(sample.value) }))
      .filter((sample) => Number.isFinite(sample.at)
        && Number.isFinite(sample.value)
        && sample.value >= -100
        && sample.value <= 200)
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_TEMPERATURE_SAMPLES_PER_DAY);
    if (samples.length > 0) {
      sanitized[dayKey] = samples;
    }
  }
  return sanitized;
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const interval of intervals.sort((a, b) => a.from - b.from)) {
    const previous = merged.at(-1);
    if (previous && interval.from <= previous.to) {
      previous.to = Math.max(previous.to, interval.to);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function sanitizeCoolingIntervals(value) {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized = {};
  for (const [dayKey, rawIntervals] of Object.entries(value)) {
    if (!Array.isArray(rawIntervals)) {
      continue;
    }
    const intervals = rawIntervals
      .filter((interval) => isRecord(interval)
        && Number.isFinite(interval.from)
        && Number.isFinite(interval.to)
        && interval.to > interval.from)
      .map((interval) => ({ from: interval.from, to: interval.to }));
    if (intervals.length > 0) {
      sanitized[dayKey] = mergeIntervals(intervals);
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
  data.temperatureHistory = sanitizeTemperatureHistory(value.temperatureHistory);
  data.coolingIntervals = sanitizeCoolingIntervals(value.coolingIntervals);

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

function addCoolingInterval(target, fromTimestampMs, toTimestampMs) {
  if (!Number.isFinite(fromTimestampMs) || !Number.isFinite(toTimestampMs) || toTimestampMs <= fromTimestampMs) {
    return;
  }

  let cursor = fromTimestampMs;
  while (cursor < toTimestampMs) {
    const currentDate = new Date(cursor);
    const dayKey = getDayKey(currentDate);
    const nextDay = new Date(cursor);
    nextDay.setHours(24, 0, 0, 0);
    const sliceEnd = Math.min(toTimestampMs, nextDay.getTime());
    if (sliceEnd <= cursor) {
      break;
    }

    const intervals = target.coolingIntervals[dayKey] || [];
    target.coolingIntervals[dayKey] = mergeIntervals([
      ...intervals,
      { from: cursor, to: sliceEnd }
    ]);
    cursor = sliceEnd;
  }
}

function addTemperatureSample(target, temperature, receivedAt, sampleIntervalMs = TEMPERATURE_SAMPLE_INTERVAL_MS) {
  if (!Number.isFinite(temperature) || !Number.isFinite(receivedAt)) {
    return;
  }

  const dayKey = getDayKey(new Date(receivedAt));
  const samples = target.temperatureHistory[dayKey] || [];
  const bucket = Math.floor(receivedAt / sampleIntervalMs);
  const existingIndex = samples.findIndex((sample) => Math.floor(sample.at / sampleIntervalMs) === bucket);
  if (existingIndex >= 0) {
    samples[existingIndex] = { at: receivedAt, value: temperature };
  } else {
    samples.push({ at: receivedAt, value: temperature });
  }
  samples.sort((a, b) => a.at - b.at);
  target.temperatureHistory[dayKey] = samples.slice(-MAX_TEMPERATURE_SAMPLES_PER_DAY);
}

class RuntimeStore extends EventEmitter {
  constructor({
    filePath,
    legacyDailyPath = null,
    legacyHourlyPath = null,
    maxObservationGapMs = 300000,
    temperatureSampleIntervalMs = TEMPERATURE_SAMPLE_INTERVAL_MS,
    detailedHistoryRetentionDays = DETAILED_HISTORY_RETENTION_DAYS,
    now = () => Date.now(),
    saveDelayMs = 30000,
    criticalSaveDelayMs = 1000,
    backupIntervalMs = 3600000
  }) {
    super();
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.legacyDailyPath = legacyDailyPath;
    this.legacyHourlyPath = legacyHourlyPath;
    this.maxObservationGapMs = maxObservationGapMs;
    this.temperatureSampleIntervalMs = temperatureSampleIntervalMs;
    this.detailedHistoryRetentionDays = detailedHistoryRetentionDays;
    this.now = now;
    this.saveDelayMs = saveDelayMs;
    this.criticalSaveDelayMs = Math.min(criticalSaveDelayMs, saveDelayMs);
    this.backupIntervalMs = backupIntervalMs;
    this.data = createEmptyData();
    this.saveTimer = null;
    this.saveTimerDelayMs = null;
    this.lastBackupAt = null;
    this.lastPruneDayKey = null;
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

    this.pruneDetailedHistory();
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

  pruneDetailedHistory() {
    const cutoff = new Date(this.now());
    cutoff.setHours(0, 0, 0, 0);
    this.lastPruneDayKey = getDayKey(cutoff);
    cutoff.setDate(cutoff.getDate() - Math.max(0, this.detailedHistoryRetentionDays - 1));
    const cutoffDayKey = getDayKey(cutoff);
    for (const collection of [this.data.temperatureHistory, this.data.coolingIntervals]) {
      for (const dayKey of Object.keys(collection)) {
        if (dayKey < cutoffDayKey) {
          delete collection[dayKey];
        }
      }
    }
  }

  recordObservation({ cooling, temperature = null, receivedAt = this.now() }) {
    if (typeof cooling !== 'boolean' || !Number.isFinite(receivedAt)) {
      throw new Error('A runtime observation requires a boolean cooling state and timestamp');
    }
    if (temperature !== null && !Number.isFinite(temperature)) {
      throw new Error('A temperature observation must be numeric or null');
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
          addCoolingInterval(this.data, previous.receivedAt, trustedEnd);
        }

        if (elapsedMs > this.maxObservationGapMs) {
          this.addGap(trustedEnd, receivedAt, 'status-not-observed');
        }
      }
    }

    const coolingChanged = previous.cooling !== cooling;
    addTemperatureSample(this.data, temperature, receivedAt, this.temperatureSampleIntervalMs);
    this.data.tracker = { cooling, receivedAt };
    // Retention is day-granular, so re-pruning on every observation only repeats work.
    if (getDayKey(new Date(receivedAt)) !== this.lastPruneDayKey) {
      this.pruneDetailedHistory();
    }
    this.scheduleSave(coolingChanged ? this.criticalSaveDelayMs : this.saveDelayMs);
  }

  // The Home Assistant state payload only needs today's cooling total. Deriving it directly
  // avoids cloning the entire retained history on every publish.
  getTodayRuntimeMs(now = this.now()) {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayKey = getDayKey(dayStart);
    let total = Number(this.data.daily[dayKey] || 0);

    const tracker = this.data.tracker;
    if (tracker.cooling === true && Number.isFinite(tracker.receivedAt)) {
      const liveEnd = Math.min(now, tracker.receivedAt + this.maxObservationGapMs);
      const liveStart = Math.max(tracker.receivedAt, dayStart.getTime());
      if (liveEnd > liveStart) {
        total += liveEnd - liveStart;
      }
    }
    return Math.max(0, total);
  }

  getReport() {
    const reportData = cloneData(this.data);
    const now = this.now();

    if (Number.isFinite(reportData.tracker.receivedAt)) {
      const liveEnd = Math.min(now, reportData.tracker.receivedAt + this.maxObservationGapMs);
      if (reportData.tracker.cooling === true) {
        addRuntimeInterval(reportData, reportData.tracker.receivedAt, liveEnd);
        addCoolingInterval(reportData, reportData.tracker.receivedAt, liveEnd);
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
      temperatureHistory: reportData.temperatureHistory,
      coolingIntervals: reportData.coolingIntervals,
      detailedHistoryRetentionDays: this.detailedHistoryRetentionDays,
      gaps: reportData.gaps,
      warning: this.loadWarning
    };
  }

  scheduleSave(delayMs = this.saveDelayMs) {
    this.dirty = true;
    // An armed timer is a coalescing window, not a debounce: later observations ride along with
    // it instead of pushing it back. A shorter request still wins, so a cooling edge is not made
    // to wait out a window that a routine sample opened.
    if (this.saveTimer) {
      if (delayMs >= this.saveTimerDelayMs) {
        return;
      }
      clearTimeout(this.saveTimer);
    }

    this.saveTimerDelayMs = delayMs;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveTimerDelayMs = null;
      this.queueWrite();
    }, delayMs);
    this.saveTimer.unref?.();
  }

  queueWrite() {
    if (!this.dirty) {
      return;
    }

    this.dirty = false;
    // Written compactly: at full retention the indented form is roughly twice the bytes, and
    // this file is rewritten in its entirety on every save.
    const serialized = `${JSON.stringify(this.data)}\n`;
    const withBackup = this.shouldRefreshBackup();
    this.writeChain = this.writeChain
      .then(() => this.atomicWrite(serialized, withBackup))
      .catch((error) => {
        this.emit('error', error);
      });
  }

  shouldRefreshBackup() {
    if (this.skipBackupOnce) {
      this.skipBackupOnce = false;
      return false;
    }
    // Copying the previous file doubles the bytes written, so the recovery point is refreshed on
    // its own cadence rather than on every save.
    return !Number.isFinite(this.lastBackupAt)
      || (this.now() - this.lastBackupAt) >= this.backupIntervalMs;
  }

  async atomicWrite(content, withBackup = true) {
    const temporaryPath = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    let handle;
    try {
      handle = await fs.promises.open(temporaryPath, 'w');
      await handle.writeFile(content, 'utf8');
      // Without this the rename below can land before the contents do, which on a kiosk that
      // gets power-cycled is exactly how an empty or truncated store appears.
      await handle.sync();
    } finally {
      await handle?.close();
    }

    try {
      if (withBackup) {
        try {
          await fs.promises.copyFile(this.filePath, this.backupPath);
          this.lastBackupAt = this.now();
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
          // Nothing to back up yet; the rename below creates the primary, and leaving
          // lastBackupAt unset lets the next save take the first real backup.
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
      this.saveTimerDelayMs = null;
    }
    this.queueWrite();
    await this.writeChain;
  }
}

module.exports = {
  RuntimeStore,
  addCoolingInterval,
  addRuntimeInterval,
  addTemperatureSample,
  createEmptyData,
  getDayKey,
  sanitizeStoredData
};
