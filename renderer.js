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
