const mqtt = require('mqtt');

// MQTT Broker Config
const MQTT_BROKER_URL = 'mqtt://192.168.1.216';
const MQTT_TOPIC_AIRCON = 'home/shop/aircon';
const MQTT_TOPIC_TEMPEST_STATS = 'homeassistant/sensor/weatherflow2mqtt_ST-00095605/observation/state';

// MQTT Client
let client;

// Tracking last interaction time for the temperature change buttons
let lastInteractionTime = Date.now();
let temperatureChangeTimeout;
let tempSetTemp;

// Tracking time of last received status message
let lastStatusMessageTime = Date.now();

// Tracking time of last received tempest stats message
let lastTempestStatsMessageTime = Date.now();

// Check every 5 minutes to see if the last status message was received more than 5 minutes ago
setInterval(() => {
  const currentTime = Date.now();
  if (currentTime - lastStatusMessageTime >= 300000) {
    // If the last status message was received more than 5 minutes ago, reconnect to the MQTT broker
    console.log('Reconnecting to MQTT broker...');
    const currentStatusLabel = document.getElementById('currentStatusLabel');
    updateValueWithAnimation(currentStatusLabel, 'Reconnecting...');
    client.end();
    connectToMqttBroker();
    // Wait a minute and check again to see if a status message has been received now
    setTimeout(() => {
      if (currentTime - lastStatusMessageTime >= 300000) {
        // If still no status message received, show an error message
        updateValueWithAnimation(currentStatusLabel, 'Lost Connection');
        // Set the status section class to error
        const statusSection = document.querySelector('.status-section');
        statusSection.classList.remove('status-cooling', 'status-heating', 'status-off', 'status-idle');
        statusSection.classList.add('status-error');
        // Set the set temperature and current temperature to dashes
        const setTemp = document.getElementById('setTemp');
        const currentTemp = document.getElementById('currentTemp');
        // clear the locally-tracked previous status data (to ensure the next status update will be processed as a change when we reconnect)
        previousStatusData = {
          Enabled: null,
          Task: null,
          Temp: null,
          SetTemp: null
        };
        setTemp.textContent = '--';
        currentTemp.textContent = '--';
      }
    }, 60000);
  }
}, 300000);

// Check every 15 minutes to see if a tempest stats message has been received in the last 15 minutes
setInterval(() => {
  const currentTime = Date.now();
  if (currentTime - lastTempestStatsMessageTime >= 900000) {
    // If a tempest stats message has not been received in the last 10 minutes, change the temp and humidity values to n/a
    const outsideTemperatureElement = document.getElementById('outside-temperature');
    const outsideHumidityElement = document.getElementById('outside-humidity');
    outsideTemperatureElement.textContent = 'n/a °F';
    outsideHumidityElement.textContent = 'n/a% H';
  }
}, 900000);

// Connect to MQTT broker
function connectToMqttBroker() {
  client = mqtt.connect(MQTT_BROKER_URL);

  console.log('Connecting to MQTT broker...')

  // MQTT connection established
  client.on('connect', () => {
    console.log('Connected to MQTT broker');
    sendStatusRequest();
  });

  // Handle MQTT message received on aircon topic
  client.on('message', (topic, message) => {
    if (topic === MQTT_TOPIC_AIRCON) {
      handleMqttMessageAircon(message.toString());
    }
    // tempest observation stats topic
    if (topic === MQTT_TOPIC_TEMPEST_STATS) {
      handleMqttMessageTempestStats(message.toString());
    }
  });

  // Subscribe to MQTT topic for aircon
  client.subscribe(MQTT_TOPIC_AIRCON);

  // Subscribe to MQTT topic for tempest stats
  client.subscribe(MQTT_TOPIC_TEMPEST_STATS);
}

// Send status request to MQTT topic
function sendStatusRequest() {
  client.publish(MQTT_TOPIC_AIRCON, 'status');
}

// Handle MQTT message
function handleMqttMessageAircon(message) {
  let jsonData;
  // ignore message if it is a status, set temp, or power on/off request
  if (message === 'status' || message.includes('set-') || message === 'on' || message === 'off') {
    return;
  }
  else {
    try {
      jsonData = JSON.parse(message);
    } catch (error) {
      console.error('Failed to parse MQTT message:', error);
      return;
    }
    // Update last status message time
    lastStatusMessageTime = Date.now();
    // Update UI with status data
    updateStatusUI(jsonData);
  }
}

// Handle MQTT message for tempest stats
function handleMqttMessageTempestStats(message) {
  let jsonData;
  try {
    jsonData = JSON.parse(message);
  } catch (error) {
    console.error('Failed to parse MQTT message:', error);
    return;
  }
  // Update last tempest stats message time
  lastTempestStatsMessageTime = Date.now();
  // Update UI with tempest stats data
  updateStatusBarStats(jsonData);
}

// Store the previous values
let previousStatusData = {
  Enabled: null,
  Task: null,
  Temp: null,
  SetTemp: null
};

function updateStatusBarStats(statusData) {
  // Update outside temperature and humidity
  const outsideTemperatureElement = document.getElementById('outside-temperature');
  outsideTemperatureElement.textContent = `${statusData.air_temperature} °F`;
  const outsideHumidityElement = document.getElementById('outside-humidity');
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
  // Helper function to check if a value has changed
  function hasValueChanged(key, value) {
    return previousStatusData[key] !== value;
  }

  // Update currentStatusLabel if value has changed
  const currentStatusLabel = document.getElementById('currentStatusLabel');
  if (hasValueChanged('Task', statusData.Task)) {
    updateValueWithAnimation(currentStatusLabel, statusData.Task == 'Cool' ? 'Cooling' : statusData.Task == 'Heat' ? 'Heating' : statusData.Task == 'OFF' ? 'Off' : 'Idle');
  }

  // TODO put a power, compressor, fan, mqtt AC pico comms, and runtime status status labels somewhere on the display
  // Update powerStatusLabel if value has changed
  // const powerStatusLabel = document.getElementById('powerStatusLabel');
  // if (hasValueChanged('Enabled', statusData.Enabled)) {
  //   updateValueWithAnimation(powerStatusLabel, statusData.Enabled ? 'On' : 'Off');
  // }

  // Update setTemp if value has changed
  const setTemp = document.getElementById('setTemp');
  if (hasValueChanged('SetTemp', statusData.SetTemp)) {
    updateValueWithAnimation(setTemp, statusData.SetTemp + '°');
    // update the locally-tracked setTemp
    tempSetTemp = statusData.SetTemp;
  }

  // Update currentTemp if value has changed
  const currentTemp = document.getElementById('currentTemp');
  if (hasValueChanged('Temp', statusData.Temp)) {
    updateValueWithAnimation(currentTemp, statusData.Temp + '°');
  }

  const statusSection = document.querySelector('.status-section');
  statusSection.classList.remove('status-cooling', 'status-heating', 'status-off', 'status-idle', 'status-error');

  // Update statusSection class (background color) based on current running status
  if (statusData.Task.toLowerCase() === 'cool') {
    statusSection.classList.add('status-cooling');
  } else if (statusData.Task.toLowerCase() === 'heating') {
    statusSection.classList.add('status-heating');
  } else if (statusData.Task.toLowerCase() === 'off') {
    statusSection.classList.add('status-off');
  } else if (statusData.Task.toLowerCase() === 'idle') {
    statusSection.classList.add('status-idle');
  }

  // Store the current values as previous values for the next update
  previousStatusData = statusData;
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

// Publish MQTT message
function publishMqttMessage(message) {
  client.publish(MQTT_TOPIC_AIRCON, message);
}

// Start the app
connectToMqttBroker();

// Get power buttons
const powerOnButton = document.getElementById('powerOnButton');
const powerOffButton = document.getElementById('powerOffButton');

// Add click event listeners
powerOnButton.addEventListener('click', () => {
  publishMqttMessage('on');
});

powerOffButton.addEventListener('click', () => {
  publishMqttMessage('off');
});

// Get the temp buttons
const tempDecreaseButton = document.getElementById('tempDecreaseButton');
const tempIncreaseButton = document.getElementById('tempIncreaseButton');

// Add click event listeners to the temp buttons
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

// Function to update the set temperature and publish the MQTT message
function updateSetTemperature(change) {
  const currentSetTemp = parseInt(setTemp.textContent, 10);
  const newSetTemp = currentSetTemp + change;

  // Check if the new set temperature is within the valid range
  if (newSetTemp >= 50 && newSetTemp <= 90) {
    const setTemp = document.getElementById('setTemp');
    setTemp.textContent = newSetTemp + '°'; // no animation
    //updateValueWithAnimation(setTemp, newSetTemp + '°', 250); // with animation
    const message = `set-${newSetTemp}`;
    publishMqttMessage(message);
  }
}

// Flag to track button disable state
let buttonsDisabled = false;

// Function to disable buttons temporarily (to prevent rapid spam pressing where MQTT messages are sent too quickly)
function disableButtonsTemporarily() {
  // Set the flag to true
  buttonsDisabled = true;

  // Disable the buttons
  tempDecreaseButton.disabled = true;
  tempIncreaseButton.disabled = true;

  // Re-enable the buttons after a delay
  setTimeout(() => {
    buttonsDisabled = false;
    tempDecreaseButton.disabled = false;
    tempIncreaseButton.disabled = false;
  }, 1000); // Adjust the delay as needed (in milliseconds)
}

// Function to handle temperature change with a delay before sending the MQTT message
function handleTemperatureChange(change) {
  const currentTime = Date.now();
  const currentSetTemp = parseInt(setTemp.textContent, 10);
  const newSetTemp = currentSetTemp + change;

  // Check if the new set temperature is within the valid range
  if (newSetTemp >= 50 && newSetTemp <= 90) {
    const setTemp = document.getElementById('setTemp');
    setTemp.textContent = newSetTemp + '°'; // no animation
    //updateValueWithAnimation(setTemp, newSetTemp + '°', 250); // with animation
    tempSetTemp = newSetTemp;
  }

  // Check if enough time has passed since the last interaction
  if (currentTime - lastInteractionTime >= 3000) {
    // Update the last interaction time
    lastInteractionTime = currentTime;

    // Clear the previous timeout if it exists
    if (temperatureChangeTimeout) {
      clearTimeout(temperatureChangeTimeout);
    }

    // Create a new timeout to send the temperature after 3 seconds
    temperatureChangeTimeout = setTimeout(() => {
      // Perform the temperature change and send the new value over MQTT
      const message = `set-${tempSetTemp}`;
      publishMqttMessage(message);
    }, 5000);
  }
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

// Function to toggle between light and dark mode
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

// Hide the mouse cursor
document.body.style.cursor = 'none';

// Add event listeners to keep the cursor hidden
document.addEventListener('mousemove', hideCursor);
document.addEventListener('touchmove', hideCursor);

function hideCursor() {
  document.body.style.cursor = 'none';
}
