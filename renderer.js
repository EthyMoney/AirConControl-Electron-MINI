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
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TEMPERATURE_CHART_WIDTH = 720;
const TEMPERATURE_CHART_HEIGHT = 280;
const TEMPERATURE_LINE_GAP_MS = 15 * 60 * 1000;

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
const temperatureHistoryChart = document.getElementById('temperatureHistoryChart');
const temperatureHistoryViewButton = document.getElementById('temperatureHistoryViewButton');
const runtimeHistoryViewButton = document.getElementById('runtimeHistoryViewButton');
const powerOnButton = document.getElementById('powerOnButton');
const powerOffButton = document.getElementById('powerOffButton');
const tempDecreaseButton = document.getElementById('tempDecreaseButton');
const tempIncreaseButton = document.getElementById('tempIncreaseButton');

let latestState = null;
let draftSetTemp = null;
let temperatureCommitTimeout = null;
let runtimeReportCache = null;
let selectedRuntimeReportDay = null;
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
  const dayKeys = [...new Set([
    ...Object.keys(report.daily || {}),
    ...Object.keys(report.temperatureHistory || {})
  ])].sort((a, b) => b.localeCompare(a));
  if (dayKeys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'runtime-report-empty';
    empty.textContent = 'No climate history yet.';
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
    const temperatures = (report.temperatureHistory?.[dayKey] || [])
      .map((sample) => Number(sample.value))
      .filter(Number.isFinite);
    const temperatureRange = temperatures.length > 0
      ? `${Math.min(...temperatures).toFixed(1)}–${Math.max(...temperatures).toFixed(1)}°F`
      : 'no temp data';
    duration.textContent = `Cooling ${formatMillisecondsToDuration(report.daily[dayKey] || 0)} · ${temperatureRange}`;
    row.append(day, duration);
    button.appendChild(row);
    button.addEventListener('click', () => openRuntimeReportDay(dayKey));
    runtimeReportList.appendChild(button);
  }
}

function createSvgElement(name, attributes = {}, text = null) {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  if (text !== null) {
    element.textContent = text;
  }
  return element;
}

function getReportDayBounds(dayKey) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function formatHistoryTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderTemperatureHistoryChart(dayKey) {
  temperatureHistoryChart.innerHTML = '';
  const samples = (runtimeReportCache?.temperatureHistory?.[dayKey] || [])
    .filter((sample) => Number.isFinite(sample.at) && Number.isFinite(sample.value))
    .sort((a, b) => a.at - b.at);
  if (samples.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'runtime-report-empty';
    empty.textContent = 'No temperature history for this day.';
    temperatureHistoryChart.appendChild(empty);
    return;
  }

  const { start: dayStart, end: dayEnd } = getReportDayBounds(dayKey);
  const intervals = (runtimeReportCache?.coolingIntervals?.[dayKey] || [])
    .filter((interval) => Number.isFinite(interval.from) && Number.isFinite(interval.to) && interval.to > interval.from);
  const values = samples.map((sample) => sample.value);
  const observedMinimum = Math.min(...values);
  const observedMaximum = Math.max(...values);
  const rangePadding = Math.max(1, (observedMaximum - observedMinimum) * 0.15);
  let chartMinimum = Math.floor(observedMinimum - rangePadding);
  let chartMaximum = Math.ceil(observedMaximum + rangePadding);
  if (chartMaximum - chartMinimum < 4) {
    const center = (chartMaximum + chartMinimum) / 2;
    chartMinimum = Math.floor(center - 2);
    chartMaximum = Math.ceil(center + 2);
  }

  const summary = document.createElement('div');
  summary.className = 'temperature-history-summary';
  summary.textContent = `${observedMinimum.toFixed(1)}–${observedMaximum.toFixed(1)}°F · blue zones = AC running · tap line for details`;

  const svg = createSvgElement('svg', {
    class: 'temperature-history-svg',
    viewBox: `0 0 ${TEMPERATURE_CHART_WIDTH} ${TEMPERATURE_CHART_HEIGHT}`,
    role: 'img',
    'aria-label': `Current temperature history for ${formatReportDate(dayKey)}`
  });
  const margin = { top: 12, right: 12, bottom: 28, left: 46 };
  const plotWidth = TEMPERATURE_CHART_WIDTH - margin.left - margin.right;
  const plotHeight = TEMPERATURE_CHART_HEIGHT - margin.top - margin.bottom;
  const xForTimestamp = (timestamp) => margin.left
    + ((timestamp - dayStart) / (dayEnd - dayStart)) * plotWidth;
  const yForTemperature = (temperature) => margin.top
    + ((chartMaximum - temperature) / (chartMaximum - chartMinimum)) * plotHeight;

  for (const interval of intervals) {
    const clippedStart = Math.max(dayStart, interval.from);
    const clippedEnd = Math.min(dayEnd, interval.to);
    if (clippedEnd <= clippedStart) continue;
    svg.appendChild(createSvgElement('rect', {
      class: 'temperature-history-cooling-zone',
      x: xForTimestamp(clippedStart),
      y: margin.top,
      width: Math.max(1, xForTimestamp(clippedEnd) - xForTimestamp(clippedStart)),
      height: plotHeight
    }));
  }

  for (let tick = 0; tick <= 2; tick += 1) {
    const value = chartMaximum - ((chartMaximum - chartMinimum) * tick) / 2;
    const y = yForTemperature(value);
    svg.appendChild(createSvgElement('line', {
      class: 'temperature-history-grid-line',
      x1: margin.left,
      y1: y,
      x2: TEMPERATURE_CHART_WIDTH - margin.right,
      y2: y
    }));
    svg.appendChild(createSvgElement('text', {
      class: 'temperature-history-axis-label',
      x: margin.left - 7,
      y: y + 4,
      'text-anchor': 'end'
    }, `${value.toFixed(0)}°`));
  }

  for (let hour = 0; hour < 24; hour += 3) {
    const tickDate = new Date(dayStart);
    tickDate.setHours(hour, 0, 0, 0);
    const x = xForTimestamp(tickDate.getTime());
    svg.appendChild(createSvgElement('line', {
      class: 'temperature-history-grid-line',
      x1: x,
      y1: margin.top,
      x2: x,
      y2: margin.top + plotHeight
    }));
    svg.appendChild(createSvgElement('text', {
      class: 'temperature-history-axis-label',
      x,
      y: TEMPERATURE_CHART_HEIGHT - 7,
      'text-anchor': hour === 0 ? 'start' : 'middle'
    }, formatHourLabel(hour)));
  }

  let segment = [];
  const appendSegment = () => {
    if (segment.length === 0) return;
    const pathData = segment.map((sample, index) => `${index === 0 ? 'M' : 'L'} ${xForTimestamp(sample.at)} ${yForTemperature(sample.value)}`).join(' ');
    svg.appendChild(createSvgElement('path', { class: 'temperature-history-line', d: pathData }));
    segment = [];
  };
  for (const sample of samples) {
    if (segment.length > 0 && sample.at - segment.at(-1).at > TEMPERATURE_LINE_GAP_MS) {
      appendSegment();
    }
    segment.push(sample);
  }
  appendSegment();

  const selection = createSvgElement('circle', {
    class: 'temperature-history-selection hidden',
    r: 5
  });
  svg.appendChild(selection);
  svg.addEventListener('click', (event) => {
    const bounds = svg.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * TEMPERATURE_CHART_WIDTH;
    const selectedTimestamp = dayStart
      + ((Math.max(margin.left, Math.min(TEMPERATURE_CHART_WIDTH - margin.right, svgX)) - margin.left) / plotWidth)
      * (dayEnd - dayStart);
    const sample = samples.reduce((nearest, candidate) => (
      Math.abs(candidate.at - selectedTimestamp) < Math.abs(nearest.at - selectedTimestamp) ? candidate : nearest
    ));
    const cooling = intervals.some((interval) => sample.at >= interval.from && sample.at < interval.to);
    selection.setAttribute('cx', xForTimestamp(sample.at));
    selection.setAttribute('cy', yForTemperature(sample.value));
    selection.classList.remove('hidden');
    summary.textContent = `${formatHistoryTime(sample.at)} · ${sample.value.toFixed(1)}°F · AC ${cooling ? 'running' : 'off'}`;
  });

  temperatureHistoryChart.append(summary, svg);
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

function setRuntimeReportDayView(view) {
  if (!selectedRuntimeReportDay) {
    return;
  }
  const showTemperature = view === 'temperature';
  temperatureHistoryChart.classList.toggle('hidden', !showTemperature);
  runtimeHourlyChart.classList.toggle('hidden', showTemperature);
  temperatureHistoryViewButton.classList.toggle('selected', showTemperature);
  runtimeHistoryViewButton.classList.toggle('selected', !showTemperature);
  if (showTemperature) {
    renderTemperatureHistoryChart(selectedRuntimeReportDay);
  } else {
    renderRuntimeHourlyChart(selectedRuntimeReportDay);
  }
}

function openRuntimeReportDay(dayKey) {
  selectedRuntimeReportDay = dayKey;
  runtimeReportDayTitle.textContent = formatReportDate(dayKey);
  runtimeReportList.classList.add('hidden');
  runtimeReportDayDetail.classList.remove('hidden');
  const hasTemperatureHistory = (runtimeReportCache?.temperatureHistory?.[dayKey]?.length || 0) > 0;
  setRuntimeReportDayView(hasTemperatureHistory ? 'temperature' : 'runtime');
}

function closeRuntimeReportDay() {
  runtimeReportDayDetail.classList.add('hidden');
  runtimeReportList.classList.remove('hidden');
  selectedRuntimeReportDay = null;
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
  document.getElementById('current-time').textContent = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
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
temperatureHistoryViewButton.addEventListener('click', () => setRuntimeReportDayView('temperature'));
runtimeHistoryViewButton.addEventListener('click', () => setRuntimeReportDayView('runtime'));

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

// Kiosk builds hide the pointer entirely; desktop builds keep it for mouse use.
if (window.airconApi.desktopMode) {
  document.body.classList.add('desktop-mode');
} else {
  document.body.style.cursor = 'none';
  document.addEventListener('mousemove', () => { document.body.style.cursor = 'none'; });
  document.addEventListener('touchmove', () => { document.body.style.cursor = 'none'; });
}
