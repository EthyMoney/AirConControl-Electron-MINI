const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getSystemctlArguments,
  isRaspberryPi,
  requestSystemPower
} = require('../system-power');

test('Raspberry Pi detection requires Linux and a matching device model', () => {
  const readPiModel = () => 'Raspberry Pi 5 Model B Rev 1.0\0';
  assert.equal(isRaspberryPi({ platform: 'linux', readFileSync: readPiModel }), true);
  assert.equal(isRaspberryPi({ platform: 'win32', readFileSync: readPiModel }), false);
  assert.equal(isRaspberryPi({ platform: 'linux', readFileSync: () => 'Generic PC' }), false);
  assert.equal(isRaspberryPi({ platform: 'linux', readFileSync: () => { throw new Error('missing'); } }), false);
});

test('system power actions are strictly allowlisted', () => {
  assert.deepEqual(getSystemctlArguments('reboot'), ['reboot']);
  assert.deepEqual(getSystemctlArguments('shutdown'), ['poweroff']);
  assert.throws(() => getSystemctlArguments('suspend'), /Unsupported system power action/);
});

test('system power uses systemctl without a shell', async () => {
  let invocation;
  const execFile = (command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null);
  };

  await requestSystemPower('shutdown', { execFile });
  assert.deepEqual(invocation, {
    command: '/usr/bin/systemctl',
    args: ['poweroff'],
    options: { timeout: 10000 }
  });
});

test('system power reports command failures', async () => {
  const execFile = (_command, _args, _options, callback) => callback(new Error('access denied'));
  await assert.rejects(
    requestSystemPower('reboot', { execFile }),
    /Unable to reboot the Raspberry Pi: access denied/
  );
});
