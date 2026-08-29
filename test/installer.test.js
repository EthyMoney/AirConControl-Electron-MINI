const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');

function runInstaller(...args) {
  return spawnSync('bash', ['installer.sh', ...args], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
}

test('installer exposes explicit non-mutating command modes', () => {
  const help = runInstaller('--help');
  assert.equal(help.status, 0, help.stderr);
  for (const mode of ['install', 'update', 'repair', 'configure-power']) {
    assert.match(help.stdout, new RegExp(`\\b${mode}\\b`));
  }

  const missingMode = runInstaller();
  assert.equal(missingMode.status, 2);
});

test('installer dry-run describes and isolates maintenance scopes', () => {
  const update = runInstaller('update', '--user', 'logan', '--dry-run');
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /git pull --ff-only, npm ci/);
  assert.doesNotMatch(update.stdout, /boot\/display|Plymouth|system packages/);

  const repair = runInstaller('repair', '--user', 'logan', '--dry-run');
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /Excluded: boot files, display drivers, Plymouth, apt upgrade, and reboot/);

  const invalidUpgrade = runInstaller('update', '--user', 'logan', '--system-upgrade', '--dry-run');
  assert.notEqual(invalidUpgrade.status, 0);
  assert.match(invalidUpgrade.stderr, /only with install/);
});

test('deployment assets supervise the kiosk without the legacy restart loop or compositor', () => {
  const installer = fs.readFileSync(path.join(projectRoot, 'installer.sh'), 'utf8');
  const autostart = fs.readFileSync(path.join(projectRoot, 'deploy', 'openbox-autostart'), 'utf8');
  const service = fs.readFileSync(path.join(projectRoot, 'deploy', 'aircon-control.service'), 'utf8');

  assert.doesNotMatch(installer, /\bpicom\b|\bpm2\b|npm-check-updates|ts-node/);
  assert.doesNotMatch(autostart, /while true|npm start|picom/);
  assert.match(autostart, /systemctl --user start --no-block aircon-control\.service/);
  assert.match(service, /Restart=always/);
  assert.match(service, /KillMode=control-group/);
  assert.match(service, /EnvironmentFile=-%h\/\.config\/aircon-control\.env/);
});
