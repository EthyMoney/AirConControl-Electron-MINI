const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RuntimeStore, getDayKey } = require('../runtime-store');

async function createStore(t, options = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aircon-runtime-test-'));
  t.after(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, 'runtime.json');
  const store = new RuntimeStore({ filePath, saveDelayMs: 100000, ...options });
  store.on('error', (error) => assert.fail(error));
  await store.initialize();
  return { filePath, store };
}

test('records the complete tail when cooling transitions to idle', async (t) => {
  let now = new Date(2026, 0, 15, 12, 0, 0).getTime();
  const { store } = await createStore(t, { now: () => now });
  const dayKey = getDayKey(new Date(now));

  store.recordObservation({ cooling: true, receivedAt: now });
  now += 120000;
  store.recordObservation({ cooling: false, receivedAt: now });

  assert.equal(store.getReport().daily[dayKey], 120000);
  await store.flush();
});

test('persists an open cooling observation across a restart', async (t) => {
  let now = new Date(2026, 1, 20, 10, 0, 0).getTime();
  const { filePath, store } = await createStore(t, { now: () => now });
  const dayKey = getDayKey(new Date(now));
  store.recordObservation({ cooling: true, receivedAt: now });
  await store.flush();

  now += 60000;
  const restarted = new RuntimeStore({ filePath, now: () => now, saveDelayMs: 100000 });
  restarted.on('error', (error) => assert.fail(error));
  await restarted.initialize();
  restarted.recordObservation({ cooling: false, receivedAt: now });
  assert.equal(restarted.getReport().daily[dayKey], 60000);
  await restarted.flush();
});

test('caps unobserved cooling and reports the coverage gap', async (t) => {
  let now = new Date(2026, 2, 10, 8, 0, 0).getTime();
  const { store } = await createStore(t, { now: () => now, maxObservationGapMs: 300000 });
  const dayKey = getDayKey(new Date(now));
  store.recordObservation({ cooling: true, receivedAt: now });
  now += 600000;
  store.recordObservation({ cooling: false, receivedAt: now });
  const report = store.getReport();

  assert.equal(report.daily[dayKey], 300000);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].to - report.gaps[0].from, 300000);
  await store.flush();
});

test('live reports expose a gap even before the next status arrives', async (t) => {
  let now = new Date(2026, 2, 11, 8, 0, 0).getTime();
  const { store } = await createStore(t, { now: () => now, maxObservationGapMs: 300000 });
  const dayKey = getDayKey(new Date(now));
  store.recordObservation({ cooling: true, receivedAt: now });
  now += 600000;
  const report = store.getReport();

  assert.equal(report.daily[dayKey], 300000);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].to - report.gaps[0].from, 300000);
  await store.flush();
});

test('splits runtime correctly at local midnight', async (t) => {
  let now = new Date(2026, 3, 5, 23, 59, 30).getTime();
  const firstDay = getDayKey(new Date(now));
  const { store } = await createStore(t, { now: () => now });
  store.recordObservation({ cooling: true, receivedAt: now });
  now += 60000;
  const secondDay = getDayKey(new Date(now));
  store.recordObservation({ cooling: false, receivedAt: now });
  const report = store.getReport();

  assert.equal(report.daily[firstDay], 30000);
  assert.equal(report.daily[secondDay], 30000);
  assert.deepEqual(report.coolingIntervals[firstDay], [{ from: now - 60000, to: now - 30000 }]);
  assert.deepEqual(report.coolingIntervals[secondDay], [{ from: now - 30000, to: now }]);
  await store.flush();
});

test('samples daily temperatures and preserves exact cooling zones', async (t) => {
  let now = new Date(2026, 4, 10, 12, 0, 0).getTime();
  const { store } = await createStore(t, {
    now: () => now,
    maxObservationGapMs: 20 * 60 * 1000,
    temperatureSampleIntervalMs: 5 * 60 * 1000
  });
  const dayKey = getDayKey(new Date(now));
  const coolingStartedAt = now;

  store.recordObservation({ cooling: true, temperature: 78, receivedAt: now });
  now += 60000;
  store.recordObservation({ cooling: true, temperature: 77.5, receivedAt: now });
  now += 4 * 60000;
  store.recordObservation({ cooling: true, temperature: 76, receivedAt: now });
  now += 5 * 60000;
  store.recordObservation({ cooling: false, temperature: 74, receivedAt: now });

  const report = store.getReport();
  assert.deepEqual(report.temperatureHistory[dayKey], [
    { at: coolingStartedAt + 60000, value: 77.5 },
    { at: coolingStartedAt + 5 * 60000, value: 76 },
    { at: coolingStartedAt + 10 * 60000, value: 74 }
  ]);
  assert.deepEqual(report.coolingIntervals[dayKey], [{
    from: coolingStartedAt,
    to: coolingStartedAt + 10 * 60000
  }]);
  await store.flush();
});

test('the cheap today total agrees with the full report, including the open interval', async (t) => {
  let now = new Date(2026, 6, 14, 9, 0, 0).getTime();
  const { store } = await createStore(t, { now: () => now, maxObservationGapMs: 300000 });
  const dayKey = getDayKey(new Date(now));

  // A closed interval.
  store.recordObservation({ cooling: true, receivedAt: now });
  now += 120000;
  store.recordObservation({ cooling: false, receivedAt: now });
  assert.equal(store.getTodayRuntimeMs(), 120000);
  assert.equal(store.getTodayRuntimeMs(), store.getReport().daily[dayKey]);

  // An interval still open accrues live, and stops accruing past the observation gap cap.
  store.recordObservation({ cooling: true, receivedAt: now });
  now += 60000;
  assert.equal(store.getTodayRuntimeMs(), 180000);
  assert.equal(store.getTodayRuntimeMs(), store.getReport().daily[dayKey]);
  now += 600000;
  assert.equal(store.getTodayRuntimeMs(), 120000 + 300000);
  assert.equal(store.getTodayRuntimeMs(), store.getReport().daily[dayKey]);
  await store.flush();
});

test('an interval running through midnight is not counted against the new day', async (t) => {
  let now = new Date(2026, 6, 14, 23, 59, 0).getTime();
  const { store } = await createStore(t, { now: () => now, maxObservationGapMs: 600000 });
  store.recordObservation({ cooling: true, receivedAt: now });

  now = new Date(2026, 6, 15, 0, 2, 0).getTime();
  // Only the two minutes after midnight belong to the new day.
  assert.equal(store.getTodayRuntimeMs(), 120000);
  assert.equal(store.getTodayRuntimeMs(), store.getReport().daily[getDayKey(new Date(now))]);
  await store.flush();
});

test('saves are coalesced and the backup is refreshed on its own cadence', async (t) => {
  let now = new Date(2026, 6, 16, 8, 0, 0).getTime();
  const { filePath, store } = await createStore(t, {
    now: () => now,
    saveDelayMs: 100000,
    backupIntervalMs: 3600000
  });

  store.recordObservation({ cooling: true, receivedAt: now });
  await store.flush();
  const stored = await fs.promises.readFile(filePath, 'utf8');
  // Written compactly: the file is rewritten whole on every save.
  assert.equal(stored.includes('\n  "daily"'), false);
  assert.equal(JSON.parse(stored).tracker.cooling, true);

  // The first save creates the primary, so the first real backup lands on the save after it.
  now += 60000;
  store.recordObservation({ cooling: false, receivedAt: now });
  await store.flush();
  const backupAfterSecond = await fs.promises.readFile(`${filePath}.bak`, 'utf8');

  // Within the backup window further saves leave the recovery point alone.
  now += 60000;
  store.recordObservation({ cooling: true, receivedAt: now });
  await store.flush();
  assert.equal(await fs.promises.readFile(`${filePath}.bak`, 'utf8'), backupAfterSecond);

  // Past the window it is refreshed again.
  now += 3600000;
  store.recordObservation({ cooling: false, receivedAt: now });
  await store.flush();
  assert.notEqual(await fs.promises.readFile(`${filePath}.bak`, 'utf8'), backupAfterSecond);
});

test('a cooling edge is persisted promptly instead of waiting out the save window', async (t) => {
  let now = new Date(2026, 6, 17, 8, 0, 0).getTime();
  const { store } = await createStore(t, {
    now: () => now,
    saveDelayMs: 100000,
    criticalSaveDelayMs: 5
  });

  store.recordObservation({ cooling: false, receivedAt: now });
  assert.equal(store.saveTimerDelayMs, 5, 'the first observation is itself an edge');

  // A routine sample rides along in the open window rather than pushing it back.
  now += 1000;
  store.recordObservation({ cooling: false, temperature: 74, receivedAt: now });
  assert.equal(store.saveTimerDelayMs, 5);

  await new Promise((resolve) => setTimeout(resolve, 25));
  await store.flush();

  // A routine sample alone opens only the long window.
  now += 1000;
  store.recordObservation({ cooling: false, temperature: 73, receivedAt: now });
  assert.equal(store.saveTimerDelayMs, 100000);

  // An edge arriving inside that window shortens it.
  now += 1000;
  store.recordObservation({ cooling: true, receivedAt: now });
  assert.equal(store.saveTimerDelayMs, 5);
  await store.flush();
});

test('migrates version 2 stores with empty detailed history', () => {
  const { sanitizeStoredData } = require('../runtime-store');
  const migrated = sanitizeStoredData({
    version: 2,
    daily: { '2026-01-01': 60000 },
    hourly: { '2026-01-01': { 12: 60000 } },
    tracker: { cooling: false, receivedAt: 1234 },
    gaps: []
  });

  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.temperatureHistory, {});
  assert.deepEqual(migrated.coolingIntervals, {});
});

test('bounds detailed history retention without deleting aggregate runtime', async (t) => {
  let now = new Date(2026, 5, 1, 12, 0, 0).getTime();
  const { store } = await createStore(t, {
    now: () => now,
    detailedHistoryRetentionDays: 2
  });
  const oldDayKey = getDayKey(new Date(now));

  store.recordObservation({ cooling: true, temperature: 76, receivedAt: now });
  now += 60000;
  store.recordObservation({ cooling: false, temperature: 75, receivedAt: now });
  now = new Date(2026, 5, 3, 12, 0, 0).getTime();
  const currentDayKey = getDayKey(new Date(now));
  store.recordObservation({ cooling: false, temperature: 74, receivedAt: now });

  const report = store.getReport();
  assert.equal(report.daily[oldDayKey], 60000);
  assert.equal(report.temperatureHistory[oldDayKey], undefined);
  assert.equal(report.coolingIntervals[oldDayKey], undefined);
  assert.equal(report.temperatureHistory[currentDayKey].length, 1);
  await store.flush();
});

test('imports legacy daily and hourly files once', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aircon-runtime-legacy-test-'));
  t.after(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const legacyDailyPath = path.join(directory, 'daily.json');
  const legacyHourlyPath = path.join(directory, 'hourly.json');
  await fs.promises.writeFile(legacyDailyPath, '{"2026-01-01":22068}');
  await fs.promises.writeFile(legacyHourlyPath, '{"2026-01-01":{"4":22068}}');
  const store = new RuntimeStore({
    filePath: path.join(directory, 'new', 'runtime.json'),
    legacyDailyPath,
    legacyHourlyPath,
    saveDelayMs: 100000
  });
  store.on('error', (error) => assert.fail(error));
  await store.initialize();

  const report = store.getReport();
  assert.equal(report.daily['2026-01-01'], 22068);
  assert.equal(report.hourly['2026-01-01']['4'], 22068);
  await store.flush();
});

test('preserves corrupt primary data and restores a valid backup', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aircon-runtime-recovery-test-'));
  t.after(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, 'runtime.json');
  await fs.promises.writeFile(filePath, '{not valid json');
  await fs.promises.writeFile(`${filePath}.bak`, JSON.stringify({
    version: 2,
    daily: { '2026-01-02': 60000 },
    hourly: { '2026-01-02': { 3: 60000 } },
    tracker: { cooling: false, receivedAt: null },
    gaps: []
  }));
  const store = new RuntimeStore({ filePath, saveDelayMs: 100000, now: () => 123456 });
  store.on('error', (error) => assert.fail(error));
  await store.initialize();

  assert.equal(store.getReport().daily['2026-01-02'], 60000);
  assert.match(store.getReport().warning, /restored the last backup/);
  assert.equal((await fs.promises.readdir(directory)).some((name) => name.includes('.corrupt-123456')), true);
  await store.flush();
  assert.equal(JSON.parse(await fs.promises.readFile(`${filePath}.bak`, 'utf8')).daily['2026-01-02'], 60000);
});
