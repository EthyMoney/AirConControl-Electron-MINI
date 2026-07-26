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
