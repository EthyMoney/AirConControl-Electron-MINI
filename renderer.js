const STATUS_CLASS_NAMES = ['status-cooling', 'status-heating', 'status-off', 'status-idle', 'status-error'];
const MIN_SET_TEMPERATURE = 50;
const MAX_SET_TEMPERATURE = 90;
const TEMPERATURE_COMMIT_DELAY_MS = 750;

const currentStatusLabel = document.getElementById('currentStatusLabel');
const setTempElement = document.getElementById('setTemp');
const currentTempElement = document.getElementById('currentTemp');
const outsideTemperatureElement = document.getElementById('outside-temperature');
const outsideHumidityElement = document.getElementById('outside-humidity');
const statusSection = document.querySelector('.status-section');
const statusRuntimeLabel = document.getElementById('statusRuntimeLabel');
const statusRuntimeInfoButton = document.getElementById('statusRuntimeInfoButton');
const fanStatusLight = document.getElementById('fanStatusLight');
const compressorStatusLight = document.getElementById('compressorStatusLight');
const runtimeReportScreen = document.getElementById('runtimeReportScreen');
const runtimeReportList = document.getElementById('runtimeReportList');
const runtimeReportCloseButton = document.getElementById('runtimeReportCloseButton');
const powerOnButton = document.getElementById('powerOnButton');
const powerOffButton = document.getElementById('powerOffButton');
const tempDecreaseButton = document.getElementById('tempDecreaseButton');
const tempIncreaseButton = document.getElementById('tempIncreaseButton');

let previousStatusData = {
  Enabled: null,
  Task: null,
  Temp: null,
  SetTemp: null
};

let pendingSetTemp = null;
let temperatureCommitTimeout = null;
let buttonsDisabled = false;

function normalizeTask(task) {
  const normalizedTask = String(task || '').trim().toLowerCase();

  if (normalizedTask === 'cool' || normalizedTask === 'cooling') {
    return 'cooling';
  }

  if (normalizedTask === 'heat' || normalizedTask === 'heating') {
    return 'heating';
  }

  if (normalizedTask === 'off') {
    return 'off';
  }

  return 'idle';
}

function formatTaskLabel(task) {
  const normalizedTask = normalizeTask(task);

  if (normalizedTask === 'cooling') {
    return 'Cooling';
  }

  if (normalizedTask === 'heating') {
    return 'Heating';
  }

  if (normalizedTask === 'off') {
    return 'Off';
  }

  return 'Idle';
}

function setStatusSectionState(state) {
  statusSection.classList.remove(...STATUS_CLASS_NAMES);

  if (state === 'cooling') {
    statusSection.classList.add('status-cooling');
    return;
  }

  if (state === 'heating') {
    statusSection.classList.add('status-heating');
    return;
  }

  if (state === 'off') {
    statusSection.classList.add('status-off');
    return;
  }

  if (state === 'error') {
    statusSection.classList.add('status-error');
    return;
  }

  statusSection.classList.add('status-idle');
}

function getDisplayedSetTemperature() {
  const parsed = Number.parseInt(setTempElement.textContent, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function setConnectionErrorState(label) {
  updateValueWithAnimation(currentStatusLabel, label);
  statusRuntimeLabel.textContent = '';
  setLightState(fanStatusLight, null);
  setLightState(compressorStatusLight, null);
  setStatusSectionState('error');
  previousStatusData = {
    Enabled: null,
    Task: null,
    Temp: null,
    SetTemp: null
  };
  setTempElement.textContent = '--';
  currentTempElement.textContent = '--';
}

function setLightState(element, state) {
  element.classList.remove('on', 'off', 'unknown');

  if (state === true) {
    element.classList.add('on');
    return;
  }

  if (state === false) {
    element.classList.add('off');
    return;
  }

  element.classList.add('unknown');
}

function normalizeBooleanState(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }

    return null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (['on', 'true', '1', 'running', 'active', 'enabled'].includes(normalized)) {
      return true;
    }

    if (['off', 'false', '0', 'idle', 'inactive', 'disabled'].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function getFirstKnownState(statusData, candidateKeys) {
  for (const key of candidateKeys) {
    if (!(key in statusData)) {
      continue;
    }

    const state = normalizeBooleanState(statusData[key]);
    if (state !== null) {
      return state;
    }
  }

  return null;
}

function getStateByKeyword(statusData, keyword) {
  const loweredKeyword = keyword.toLowerCase();

  for (const [key, value] of Object.entries(statusData)) {
    if (!String(key).toLowerCase().includes(loweredKeyword)) {
      continue;
    }

    const state = normalizeBooleanState(value);
    if (state !== null) {
      return state;
    }
  }

  return null;
}

function updateHardwareLights(statusData) {
  const fanState =
    getFirstKnownState(statusData, ['Fan', 'fan', 'FanOn', 'fanOn', 'FanON', 'Blower', 'blower'])
    ?? getStateByKeyword(statusData, 'fan')
    ?? getStateByKeyword(statusData, 'blower');
  const compressorState =
    getFirstKnownState(statusData, ['Compressor', 'compressor', 'CompressorOn', 'compressorOn', 'CompON', 'compON', 'CompOn', 'compOn'])
    ?? getStateByKeyword(statusData, 'compressor');

  setLightState(fanStatusLight, fanState);
  setLightState(compressorStatusLight, compressorState);
}

function parseDurationStringToMinutes(value) {
  const trimmed = String(value).trim();

  if (!trimmed) {
    return null;
  }

  const hhmmssMatch = trimmed.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hhmmssMatch) {
    const hours = Number.parseInt(hhmmssMatch[1], 10);
    const minutes = Number.parseInt(hhmmssMatch[2], 10);
    const seconds = hhmmssMatch[3] ? Number.parseInt(hhmmssMatch[3], 10) : 0;
    return (hours * 60) + minutes + (seconds / 60);
  }

  const hrMatch = trimmed.match(/(\d+)\s*(h|hr|hrs|hour|hours)/i);
  const minMatch = trimmed.match(/(\d+)\s*(m|min|mins|minute|minutes)/i);
  if (hrMatch || minMatch) {
    const hours = hrMatch ? Number.parseInt(hrMatch[1], 10) : 0;
    const minutes = minMatch ? Number.parseInt(minMatch[1], 10) : 0;
    return (hours * 60) + minutes;
  }

  const numeric = Number.parseFloat(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  return null;
}

function parseNumericRuntimeToMinutes(value) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  const nowMs = Date.now();

  // Unix timestamp in milliseconds.
  if (value >= 1e12) {
    return Math.max(0, (nowMs - value) / 60000);
  }

  // Unix timestamp in seconds.
  if (value >= 1e9) {
    return Math.max(0, ((nowMs / 1000) - value) / 60);
  }

  // Generic runtime counters are treated as milliseconds.
  return value / 60000;
}

function getRuntimeMinutes(statusData) {
  const minuteFields = ['RuntimeMinutes', 'runtimeMinutes', 'RuntimeMins', 'runtimeMins'];
  for (const key of minuteFields) {
    const value = statusData[key];
    if (Number.isFinite(value)) {
      return value;
    }
  }

  const secondFields = ['RuntimeSeconds', 'runtimeSeconds', 'RuntimeSec', 'runtimeSec'];
  for (const key of secondFields) {
    const value = statusData[key];
    if (Number.isFinite(value)) {
      return value / 60;
    }
  }

  const runtimeFields = ['Runtime', 'runtime', 'runTime'];
  for (const key of runtimeFields) {
    const value = statusData[key];

    if (Number.isFinite(value)) {
      return parseNumericRuntimeToMinutes(value);
    }

    if (typeof value === 'string') {
      const numericValue = Number.parseFloat(value);
      if (Number.isFinite(numericValue)) {
        return parseNumericRuntimeToMinutes(numericValue);
      }

      const parsed = parseDurationStringToMinutes(value);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

function formatRuntimeLabel(minutes) {
  const wholeMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(wholeMinutes / 60);
  const remainingMinutes = wholeMinutes % 60;

  if (hours <= 0) {
    return `for ${wholeMinutes}m`;
  }

  if (remainingMinutes === 0) {
    return `for ${hours}hr`;
  }

  return `for ${hours}hr ${remainingMinutes}m`;
}

function formatMillisecondsToDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${remainingMinutes}m`;
  }

  if (remainingMinutes === 0) {
    return `${hours}hr`;
  }

  return `${hours}hr ${remainingMinutes}m`;
}

function renderRuntimeReportRows(report) {
  runtimeReportList.innerHTML = '';

  const dayKeys = Object.keys(report || {}).sort((a, b) => b.localeCompare(a));
  if (dayKeys.length === 0) {
    const emptyElement = document.createElement('div');
    emptyElement.className = 'runtime-report-empty';
    emptyElement.textContent = 'No runtime data yet.';
    runtimeReportList.appendChild(emptyElement);
    return;
  }

  for (const dayKey of dayKeys) {
    const runtimeMs = Number(report[dayKey] || 0);

    const row = document.createElement('div');
    row.className = 'runtime-report-row';

    const day = document.createElement('span');
    day.textContent = dayKey;

    const duration = document.createElement('span');
    duration.textContent = formatMillisecondsToDuration(runtimeMs);

    row.appendChild(day);
    row.appendChild(duration);
    runtimeReportList.appendChild(row);
  }
}

async function openRuntimeReport() {
  runtimeReportList.innerHTML = '';

  try {
    const report = await window.airconApi.getCoolingRuntimeReport();
    renderRuntimeReportRows(report || {});
  } catch (_error) {
    const errorElement = document.createElement('div');
    errorElement.className = 'runtime-report-empty';
    errorElement.textContent = 'Failed to load runtime data.';
    runtimeReportList.appendChild(errorElement);
  }

  runtimeReportScreen.classList.remove('hidden');
}

function closeRuntimeReport() {
  runtimeReportScreen.classList.add('hidden');
}

function updateStatusRuntime(statusData) {
  const runtimeMinutes = getRuntimeMinutes(statusData);
  if (runtimeMinutes === null) {
    statusRuntimeLabel.textContent = '';
    return;
  }

  statusRuntimeLabel.textContent = formatRuntimeLabel(runtimeMinutes);
}

function updateStatusBarStats(statusData) {
  outsideTemperatureElement.textContent = `${statusData.air_temperature} °F`;
  outsideHumidityElement.textContent = `${statusData.relative_humidity.toFixed(1)}% H`;
}

function updateStatusBarTime() {
  // Update current time
  const date = new Date();
  let hours = date.getHours();
  let minutes = date.getMinutes();
  let ampm = hours >= 12 ? 'PM' : 'AM';

  // Convert to 12-hour format
  hours = hours % 12 || 12;

  // Add leading zeros to minutes if necessary
  minutes = minutes < 10 ? '0' + minutes : minutes;

  // Set formatted time
  const currentTime = hours + ':' + minutes + ' ' + ampm;
  const currentTimeElement = document.getElementById('current-time');
  currentTimeElement.textContent = `${currentTime}`;
}

// schedule time update every 5 seconds
setInterval(updateStatusBarTime, 5000);

// first run time update
updateStatusBarTime();

// Update UI with status data
function updateStatusUI(statusData) {
  function hasValueChanged(key, value) {
    return previousStatusData[key] !== value;
  }

  if (hasValueChanged('Task', statusData.Task)) {
    updateValueWithAnimation(currentStatusLabel, formatTaskLabel(statusData.Task));
  }

  if (hasValueChanged('SetTemp', statusData.SetTemp)) {
    updateValueWithAnimation(setTempElement, statusData.SetTemp + '°');
    pendingSetTemp = statusData.SetTemp;
  }

  if (hasValueChanged('Temp', statusData.Temp)) {
    updateValueWithAnimation(currentTempElement, statusData.Temp + '°');
  }

  updateStatusRuntime(statusData);
  updateHardwareLights(statusData);

  setStatusSectionState(normalizeTask(statusData.Task));

  previousStatusData = {
    Enabled: statusData.Enabled,
    Task: statusData.Task,
    Temp: statusData.Temp,
    SetTemp: statusData.SetTemp
  };
}

// Function to trigger the value change animation
function triggerValueChangeAnimation(element, timeout = 1000) {
  // Add the "value-change" class to the element
  element.classList.add('value-change');

  // Remove the "value-change" class after a delay
  setTimeout(() => {
    element.classList.remove('value-change');
  }, timeout); // Adjust the duration as needed (in milliseconds)
}

// Helper function to update the value and trigger animation
function updateValueWithAnimation(element, value, timeout) {
  element.textContent = value;
  triggerValueChangeAnimation(element, timeout);
}

powerOnButton.addEventListener('click', () => {
  window.airconApi.publishCommand('on');
});

powerOffButton.addEventListener('click', () => {
  window.airconApi.publishCommand('off');
});

tempDecreaseButton.addEventListener('click', () => {
  if (!buttonsDisabled) {
    handleTemperatureChange(-1);
  }
});

tempIncreaseButton.addEventListener('click', () => {
  if (!buttonsDisabled) {
    handleTemperatureChange(1);
  }
});

statusRuntimeInfoButton.addEventListener('click', () => {
  openRuntimeReport();
});

runtimeReportCloseButton.addEventListener('click', () => {
  closeRuntimeReport();
});

function disableButtonsTemporarily() {
  buttonsDisabled = true;
  tempDecreaseButton.disabled = true;
  tempIncreaseButton.disabled = true;

  setTimeout(() => {
    buttonsDisabled = false;
    tempDecreaseButton.disabled = false;
    tempIncreaseButton.disabled = false;
  }, 250);
}

function handleTemperatureChange(change) {
  const currentSetTemp = pendingSetTemp ?? getDisplayedSetTemperature();

  if (currentSetTemp === null) {
    return;
  }

  const nextSetTemp = Math.min(MAX_SET_TEMPERATURE, Math.max(MIN_SET_TEMPERATURE, currentSetTemp + change));

  if (nextSetTemp === currentSetTemp) {
    return;
  }

  pendingSetTemp = nextSetTemp;
  setTempElement.textContent = `${nextSetTemp}°`;
  disableButtonsTemporarily();

  if (temperatureCommitTimeout) {
    clearTimeout(temperatureCommitTimeout);
  }

  temperatureCommitTimeout = setTimeout(() => {
    window.airconApi.publishCommand(`set-${pendingSetTemp}`);
  }, TEMPERATURE_COMMIT_DELAY_MS);
}

//
// Light/Dark Mode Theming
//

// Function to check if it's currently nighttime (after 7pm)
function isNighttime() {
  const now = new Date();
  const hour = now.getHours();
  //console.log('nighttime check: ' + hour + ' hours')
  //console.log('nighttime check: ' + (hour >= 19 || hour < 6))
  return hour >= 19 || hour < 6; // Nighttime is from 7pm to 5:59am
}

function toggleLightMode() {
  const container = document.querySelector('.container');
  container.classList.toggle('light-mode');
}

function checkAndSetTheme() {
  const nightTime = isNighttime();
  if (nightTime && document.querySelector('.container').classList.contains('light-mode')) {
    toggleLightMode();
  } else if (!nightTime && !document.querySelector('.container').classList.contains('light-mode')) {
    toggleLightMode();
  }
}

// Check the time every minute and update the mode if necessary
setInterval(() => checkAndSetTheme(), 60000); // Check every minute (adjust the interval as desired)

// Set the theme initially
checkAndSetTheme();

window.airconApi.onStatus((payload) => {
  updateStatusUI(payload);
});

window.airconApi.onTempest((payload) => {
  updateStatusBarStats(payload);
});

window.airconApi.onConnection((payload) => {
  if (payload.state === 'connected') {
    return;
  }

  if (payload.state === 'reconnecting' || payload.state === 'offline' || payload.state === 'stale-status') {
    updateValueWithAnimation(currentStatusLabel, 'Reconnecting...');
    setStatusSectionState('error');
    return;
  }

  if (payload.state === 'error') {
    setConnectionErrorState('Connection Error');
    return;
  }

  if (payload.state === 'closed') {
    setConnectionErrorState('Lost Connection');
  }
});

window.airconApi.onTempestStale((isStale) => {
  if (!isStale) {
    return;
  }

  outsideTemperatureElement.textContent = 'n/a °F';
  outsideHumidityElement.textContent = 'n/a% H';
});

window.airconApi.requestStatus();

// Hide the mouse cursor
document.body.style.cursor = 'none';

// Add event listeners to keep the cursor hidden
document.addEventListener('mousemove', hideCursor);
document.addEventListener('touchmove', hideCursor);

function hideCursor() {
  document.body.style.cursor = 'none';
}
