const childProcess = require('child_process');
const fs = require('fs');

const RASPBERRY_PI_MODEL_PATHS = [
  '/proc/device-tree/model',
  '/sys/firmware/devicetree/base/model'
];

function isRaspberryPi({ platform = process.platform, readFileSync = fs.readFileSync } = {}) {
  if (platform !== 'linux') {
    return false;
  }

  return RASPBERRY_PI_MODEL_PATHS.some((modelPath) => {
    try {
      return /raspberry pi/i.test(readFileSync(modelPath, 'utf8').replace(/\0/g, ''));
    } catch {
      return false;
    }
  });
}

function getSystemctlArguments(action) {
  if (action === 'reboot') {
    return ['reboot'];
  }
  if (action === 'shutdown') {
    return ['poweroff'];
  }
  throw new Error('Unsupported system power action');
}

function requestSystemPower(action, {
  execFile = childProcess.execFile,
  command = '/usr/bin/systemctl'
} = {}) {
  const args = getSystemctlArguments(action);
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10000 }, (error) => {
      if (error) {
        reject(new Error(`Unable to ${action} the Raspberry Pi: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  getSystemctlArguments,
  isRaspberryPi,
  requestSystemPower
};
