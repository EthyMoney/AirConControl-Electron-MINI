const STATUS_CLASS_NAMES = [
  'status-cooling',
  'status-heating',
  'status-off',
  'status-idle',
  'status-error',
  'status-unknown',
  'status-stale'
];
const MIN_SET_TEMPERATURE = 50;
const MAX_SET_TEMPERATURE = 90;
const TEMPERATURE_COMMIT_DELAY_MS = 750;

const currentStatusLabel = document.getElementById('currentStatusLabel');
const statusHealthLabel = document.getElementById('statusHealthLabel');
const commandStatusLabel = document.getElementById('commandStatusLabel');
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
const runtimeReportMeta = document.getElementById('runtimeReportMeta');
const runtimeReportCloseButton = document.getElementById('runtimeReportCloseButton');
const runtimeReportDayDetail = document.getElementById('runtimeReportDayDetail');
const runtimeReportDayTitle = document.getElementById('runtimeReportDayTitle');
const runtimeReportDayBackButton = document.getElementById('runtimeReportDayBackButton');
const runtimeHourlyChart = document.getElementById('runtimeHourlyChart');
const powerOnButton = document.getElementById('powerOnButton');
const powerOffButton = document.getElementById('powerOffButton');
const tempDecreaseButton = document.getElementById('tempDecreaseButton');
const tempIncreaseButton = document.getElementById('tempIncreaseButton');

let latestState = null;
let draftSetTemp = null;
let temperatureCommitTimeout = null;
let runtimeReportCache = null;
let localCommandError = null;

function triggerValueChangeAnimation(element) {
  element.classList.remove('value-change');
  void element.offsetWidth;
  element.classList.add('value-change');
  setTimeout(() => element.classList.remove('value-change'), 1000);
}

function setAnimatedText(element, value) {
  const text = String(value);
  if (element.textContent !== text) {
    element.textContent = text;
    triggerValueChangeAnimation(element);
  }
}

function setLightState(element, state) {
  element.classList.remove('on', 'off', 'unknown');
  element.classList.add(state === true ? 'on' : state === false ? 'off' : 'unknown');
}

function formatTaskLabel(task, enabled) {
  if (enabled === false || task === 'off') {
    return 'Off';
  }
  const labels = {
    cooling: 'Cooling',
    heating: 'Heating',
    idle: 'Idle',
    fault: 'Fault',
    unknown: 'Unknown'
  };
  return labels[task] || 'Unknown';
}

function getVisualTask(reported) {
  if (!reported) {
    return 'unknown';
  }
  if (reported.task === 'fault') {
    return 'error';
  }
  if (reported.enabled === false || reported.task === 'off') {
    return 'off';
  }
  return ['cooling', 'heating', 'idle'].includes(reported.task) ? reported.task : 'unknown';
}

function setStatusSectionState(task, freshness) {
  statusSection.classList.remove(...STATUS_CLASS_NAMES);
  const className = {
    cooling: 'status-cooling',
    heating: 'status-heating',
    off: 'status-off',
    idle: 'status-idle',
    error: 'status-error',
    unknown: 'status-unknown'
  }[task] || 'status-unknown';
  statusSection.classList.add(className);
  if (freshness === 'stale') {
    statusSection.classList.add('status-stale');
  }
}

function formatAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) {
    return 'never';
  }
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function formatMillisecondsToDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${totalMinutes}m`;
  }
  return minutes === 0 ? `${hours}hr` : `${hours}hr ${minutes}m`;
}

function getLiveRuntimeMs(reported, airconState) {
  if (!reported || !Number.isFinite(reported.runtimeMs)) {
    return null;
  }
  const isRunning = ['cooling', 'heating'].includes(reported.task);
  const observationEnd = airconState.freshness === 'stale'
    ? airconState.freshnessChangedAt
    : Date.now();
  const elapsed = isRunning && Number.isFinite(airconState.receivedAt)
    ? Math.max(0, observationEnd - airconState.receivedAt)
    : 0;
  return reported.runtimeMs + elapsed;
}

function getActiveCommand() {
  const command = latestState?.command;
  return command && ['pending', 'published'].includes(command.status) ? command : null;
}

function renderCommand(command) {
  if (localCommandError) {
    commandStatusLabel.textContent = localCommandError;
    commandStatusLabel.className = 'status-command command-error';
    return;
  }
  if (!command) {
    commandStatusLabel.textContent = '';
    commandStatusLabel.className = 'status-command';
    return;
  }

  const desiredLabel = command.type === 'set-temperature'
    ? `Setting ${command.desired.setTemp}°`
    : `Turning ${command.desired.enabled ? 'on' : 'off'}`;
  if (command.status === 'pending' || command.status === 'published') {
    commandStatusLabel.textContent = `${desiredLabel}… awaiting confirmation`;
    commandStatusLabel.className = 'status-command command-pending';
  } else if (command.status === 'confirmed' && Date.now() - command.completedAt < 4000) {
    commandStatusLabel.textContent = `${desiredLabel} — confirmed`;
    commandStatusLabel.className = 'status-command command-confirmed';
  } else if (command.status === 'failed' || command.status === 'timed-out') {
    commandStatusLabel.textContent = `${desiredLabel} failed: ${command.error}`;
    commandStatusLabel.className = 'status-command command-error';
  } else {
    commandStatusLabel.textContent = '';
    commandStatusLabel.className = 'status-command';
  }
}

function renderWeather(weather) {
  if (!weather?.reported) {
    outsideTemperatureElement.textContent = weather?.error ? 'weather error' : 'waiting';
    outsideHumidityElement.textContent = 'waiting';
    return;
  }
  const staleMarker = weather.freshness === 'stale' ? '*' : '';
  outsideTemperatureElement.textContent = `${weather.reported.temperature} °F${staleMarker}`;
  outsideHumidityElement.textContent = `${weather.reported.humidity.toFixed(1)}% H${staleMarker}`;
}

function renderControls(state) {
  const reported = state.aircon.reported;
  const activeCommand = getActiveCommand();
  const controlsAvailable = state.mqtt.status === 'connected'
    && state.aircon.freshness === 'fresh'
    && Boolean(reported)
    && !activeCommand;

  tempDecreaseButton.disabled = !controlsAvailable;
  tempIncreaseButton.disabled = !controlsAvailable;
  powerOnButton.disabled = !controlsAvailable;
  powerOffButton.disabled = !controlsAvailable;

  const desiredSetTemp = activeCommand?.type === 'set-temperature' ? activeCommand.desired.setTemp : null;
  const displayedSetTemp = draftSetTemp ?? desiredSetTemp ?? reported?.setTemp ?? null;
  setAnimatedText(setTempElement, displayedSetTemp === null ? '--' : `${displayedSetTemp}°`);
  setAnimatedText(currentTempElement, reported?.temp === null || reported?.temp === undefined ? '--' : `${reported.temp}°`);

  const isOn = Boolean(reported) && (
    reported.enabled === true
    || (reported.enabled === null && ['idle', 'cooling', 'heating'].includes(reported.task))
  );
  const isOff = Boolean(reported) && (
    reported.enabled === false
    || (reported.enabled === null && reported.task === 'off')
  );
  powerOnButton.classList.toggle('selected', isOn);
  powerOffButton.classList.toggle('selected', isOff);
}

function renderState() {
  if (!latestState) {
    return;
  }

  const { mqtt, aircon, weather, command, storage, homeAssistant } = latestState;
  const reported = aircon.reported;
  let statusLabel;
  if (reported) {
    statusLabel = formatTaskLabel(reported.task, reported.enabled);
  } else if (mqtt.status === 'connecting' || mqtt.status === 'reconnecting') {
    statusLabel = 'Connecting…';
  } else if (mqtt.status === 'connected') {
    statusLabel = 'Waiting for status…';
  } else {
    statusLabel = 'Not Connected';
  }

  setAnimatedText(currentStatusLabel, statusLabel);
  setStatusSectionState(getVisualTask(reported), aircon.freshness);
  setLightState(fanStatusLight, reported?.fanOn ?? null);
  setLightState(compressorStatusLight, reported?.compressorOn ?? null);

  const runtimeMs = getLiveRuntimeMs(reported, aircon);
  statusRuntimeLabel.textContent = runtimeMs === null ? '' : `for ${formatMillisecondsToDuration(runtimeMs)}`;

  const healthParts = [`MQTT ${mqtt.status}`];
  if (aircon.receivedAt) {
    healthParts.push(`${aircon.freshness === 'stale' ? 'stale, last update' : 'updated'} ${formatAge(aircon.receivedAt)}`);
  }
  if (aircon.error) {
    healthParts.push(aircon.error);
  }
  if (storage.status !== 'ready') {
    healthParts.push(`storage ${storage.status}`);
  }
  if (homeAssistant?.enabled) {
    healthParts.push(`HA ${homeAssistant.status}`);
  }
  statusHealthLabel.textContent = healthParts.join(' · ');

  renderWeather(weather);
  renderCommand(command);
  renderControls(latestState);
}

function acceptState(snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.revision)) {
    return;
  }
  if (latestState && snapshot.revision < latestState.revision) {
    return;
  }
  latestState = snapshot;
  localCommandError = null;
  renderState();
}

async function sendCommand(command) {
  localCommandError = null;
  try {
    const result = await window.airconApi.sendCommand(command);
    if (!result?.ok) {
      localCommandError = result?.error || 'Command failed';
      renderState();
    }
  } catch (error) {
    localCommandError = error.message || 'Command failed';
    renderState();
  }
}

function handleTemperatureChange(change) {
  const activeCommand = getActiveCommand();
  const currentSetTemp = draftSetTemp
    ?? (activeCommand?.type === 'set-temperature' ? activeCommand.desired.setTemp : null)
    ?? latestState?.aircon?.reported?.setTemp;
  if (!Number.isFinite(currentSetTemp)) {
    return;
  }

  const nextSetTemp = Math.min(MAX_SET_TEMPERATURE, Math.max(MIN_SET_TEMPERATURE, currentSetTemp + change));
  if (nextSetTemp === currentSetTemp) {
    return;
  }
  draftSetTemp = nextSetTemp;
  renderState();

  if (temperatureCommitTimeout) {
    clearTimeout(temperatureCommitTimeout);
  }
  temperatureCommitTimeout = setTimeout(() => {
    temperatureCommitTimeout = null;
    const committedSetTemp = draftSetTemp;
    draftSetTemp = null;
    sendCommand(`set-${committedSetTemp}`);
  }, TEMPERATURE_COMMIT_DELAY_MS);
}

function formatReportDate(dayKey) {
  const parts = String(dayKey).split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : String(dayKey);
}

function formatHourLabel(hourIndex) {
  if (hourIndex === 0) return '12a';
  if (hourIndex < 12) return `${hourIndex}a`;
  if (hourIndex === 12) return '12p';
  return `${hourIndex - 12}p`;
}

function formatHourRange(hourIndex) {
  return `${formatHourLabel(hourIndex)}–${formatHourLabel((hourIndex + 1) % 24)}`;
}

function renderRuntimeReportRows(report) {
  runtimeReportList.innerHTML = '';
  const dayKeys = Object.keys(report.daily || {}).sort((a, b) => b.localeCompare(a));
  if (dayKeys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'runtime-report-empty';
    empty.textContent = 'No observed cooling runtime yet.';
    runtimeReportList.appendChild(empty);
    return;
  }

  for (const dayKey of dayKeys) {
    const button = document.createElement('button');
    button.className = 'runtime-report-row-button';
    const row = document.createElement('div');
    row.className = 'runtime-report-row';
    const day = document.createElement('span');
    day.textContent = formatReportDate(dayKey);
    const duration = document.createElement('span');
    duration.textContent = formatMillisecondsToDuration(report.daily[dayKey]);
    row.append(day, duration);
    button.appendChild(row);
    button.addEventListener('click', () => openRuntimeReportDay(dayKey));
    runtimeReportList.appendChild(button);
  }
}

function renderRuntimeHourlyChart(dayKey) {
  runtimeHourlyChart.innerHTML = '';
  const dayHourlyData = runtimeReportCache?.hourly?.[dayKey] || {};
  const values = Array.from({ length: 24 }, (_unused, hour) => Math.max(0, Number(dayHourlyData[String(hour)] || 0)));
  if (Math.max(...values) <= 0) {
    const empty = document.createElement('div');
    empty.className = 'runtime-report-empty';
    empty.textContent = 'No hourly runtime for this day.';
    runtimeHourlyChart.appendChild(empty);
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'runtime-hourly-summary';
  const total = values.reduce((sum, value) => sum + value, 0);
  summary.textContent = `${formatMillisecondsToDuration(total)} total · tap a bar for details`;

  const plot = document.createElement('div');
  plot.className = 'runtime-hourly-plot';

  const yAxis = document.createElement('div');
  yAxis.className = 'runtime-hour-y-axis';
  for (const labelText of ['60m', '30m', '0']) {
    const label = document.createElement('span');
    label.textContent = labelText;
    yAxis.appendChild(label);
  }

  const bars = document.createElement('div');
  bars.className = 'runtime-hour-bars';
  values.forEach((value, hour) => {
    const column = document.createElement('button');
    column.className = 'runtime-hour-column';
    column.type = 'button';
    column.setAttribute('aria-label', `${formatHourRange(hour)}: ${formatMillisecondsToDuration(value)} cooling`);

    const meter = document.createElement('span');
    meter.className = 'runtime-hour-meter';
    const fill = document.createElement('span');
    fill.className = 'runtime-hour-fill';
    fill.style.height = `${Math.min(100, (value / 3600000) * 100)}%`;
    meter.appendChild(fill);

    const label = document.createElement('span');
    label.className = 'runtime-hour-label';
    label.textContent = hour % 3 === 0 ? formatHourLabel(hour) : '';

    column.append(meter, label);
    column.addEventListener('click', () => {
      bars.querySelector('.selected')?.classList.remove('selected');
      column.classList.add('selected');
      summary.textContent = `${formatHourRange(hour)} · ${formatMillisecondsToDuration(value)} cooling`;
    });
    bars.appendChild(column);
  });

  plot.append(yAxis, bars);
  runtimeHourlyChart.append(summary, plot);
}

function openRuntimeReportDay(dayKey) {
  runtimeReportDayTitle.textContent = `${formatReportDate(dayKey)} Hourly`;
  renderRuntimeHourlyChart(dayKey);
  runtimeReportList.classList.add('hidden');
  runtimeReportDayDetail.classList.remove('hidden');
}

function closeRuntimeReportDay() {
  runtimeReportDayDetail.classList.add('hidden');
  runtimeReportList.classList.remove('hidden');
}

async function openRuntimeReport() {
  runtimeReportList.innerHTML = '';
  runtimeReportMeta.textContent = 'Loading report…';
  closeRuntimeReportDay();
  runtimeReportScreen.classList.remove('hidden');
  try {
    runtimeReportCache = await window.airconApi.getRuntimeReport();
    const generated = new Date(runtimeReportCache.generatedAt).toLocaleString();
    const gapCount = runtimeReportCache.gaps?.length || 0;
    const warning = runtimeReportCache.warning ? ` · ${runtimeReportCache.warning}` : '';
    runtimeReportMeta.textContent = `Generated ${generated} · ${runtimeReportCache.timezone} · ${gapCount} coverage gap${gapCount === 1 ? '' : 's'}${warning}`;
    renderRuntimeReportRows(runtimeReportCache);
  } catch (_error) {
    runtimeReportMeta.textContent = 'Runtime report unavailable.';
    const errorElement = document.createElement('div');
    errorElement.className = 'runtime-report-empty';
    errorElement.textContent = 'Failed to load runtime data.';
    runtimeReportList.appendChild(errorElement);
  }
}

function closeRuntimeReport() {
  closeRuntimeReportDay();
  runtimeReportScreen.classList.add('hidden');
}

function updateClock() {
  const date = new Date();
  document.getElementById('current-time').textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function isNighttime() {
  const hour = new Date().getHours();
  return hour >= 19 || hour < 6;
}

function checkAndSetTheme() {
  document.querySelector('.container').classList.toggle('light-mode', !isNighttime());
}

powerOnButton.addEventListener('click', () => sendCommand('on'));
powerOffButton.addEventListener('click', () => sendCommand('off'));
tempDecreaseButton.addEventListener('click', () => handleTemperatureChange(-1));
tempIncreaseButton.addEventListener('click', () => handleTemperatureChange(1));
statusRuntimeInfoButton.addEventListener('click', openRuntimeReport);
runtimeReportCloseButton.addEventListener('click', closeRuntimeReport);
runtimeReportDayBackButton.addEventListener('click', closeRuntimeReportDay);

window.airconApi.onState(acceptState);
window.airconApi.getState().then(acceptState).catch((error) => {
  localCommandError = `Startup failed: ${error.message}`;
});
window.airconApi.requestStatus().catch(() => {});

updateClock();
checkAndSetTheme();
setInterval(updateClock, 5000);
setInterval(() => {
  renderState();
  checkAndSetTheme();
}, 1000);

document.body.style.cursor = 'none';
document.addEventListener('mousemove', () => { document.body.style.cursor = 'none'; });
document.addEventListener('touchmove', () => { document.body.style.cursor = 'none'; });
