const mqtt = require('mqtt');

// MQTT Broker Config
const MQTT_BROKER_URL = 'mqtt://192.168.1.55';
const MQTT_TOPIC = 'home/shop/aircon';

// MQTT Client
let client;

// Connect to MQTT broker
function connectToMqttBroker() {
  client = mqtt.connect(MQTT_BROKER_URL);

  // MQTT connection established
  client.on('connect', () => {
    console.log('Connected to MQTT broker');
    sendStatusRequest();
  });

  // Handle MQTT message received
  client.on('message', (topic, message) => {
    if (topic === MQTT_TOPIC) {
      handleMqttMessage(message.toString());
    }
  });

  // Subscribe to MQTT topic
  client.subscribe(MQTT_TOPIC);
}

// Send status request to MQTT topic
function sendStatusRequest() {
  client.publish(MQTT_TOPIC, 'status');
}

// Handle MQTT message
function handleMqttMessage(message) {
  let jsonData;
  try {
    jsonData = JSON.parse(message);
  } catch (error) {
    console.error('Failed to parse MQTT message:', error);
    return;
  }

  // Update UI with status data
  updateStatusUI(jsonData);
}

// Store the previous values
let previousStatusData = {
  Enabled: null,
  Task: null,
  Temp: null,
  SetTemp: null
};

// Update UI with status data
function updateStatusUI(statusData) {
  // Helper function to check if a value has changed
  function hasValueChanged(key, value) {
    return previousStatusData[key] !== value;
  }

  // Helper function to update the value and trigger animation
  function updateValueWithAnimation(element, value) {
    element.textContent = value;
    triggerValueChangeAnimation(element);
  }

  // Update currentStatusLabel if value has changed
  const currentStatusLabel = document.getElementById('currentStatusLabel');
  if (hasValueChanged('Task', statusData.Task)) {
    updateValueWithAnimation(currentStatusLabel, statusData.Task);
  }

  // Update powerStatusLabel if value has changed
  const powerStatusLabel = document.getElementById('powerStatusLabel');
  if (hasValueChanged('Enabled', statusData.Enabled)) {
    updateValueWithAnimation(powerStatusLabel, statusData.Enabled ? 'On' : 'Off');
  }

  // Update setTemp if value has changed
  const setTemp = document.getElementById('setTemp');
  if (hasValueChanged('SetTemp', statusData.SetTemp)) {
    updateValueWithAnimation(setTemp, statusData.SetTemp + '°');
  }

  // Update currentTemp if value has changed
  const currentTemp = document.getElementById('currentTemp');
  if (hasValueChanged('Temp', statusData.Temp)) {
    updateValueWithAnimation(currentTemp, statusData.Temp + '°');
  }

  // const powerIndicator = document.getElementById('powerIndicator');
  // powerIndicator.classList.toggle('on', statusData.Enabled === true);

  // const statusIndicator = document.getElementById('statusIndicator');
  // // Update status indicator
  // statusIndicator.classList.remove('blue', 'yellow', 'red');
  // if (statusData.Task === 'Cool') {
  //   statusIndicator.classList.add('blue');
  // } else if (statusData.Task === 'Idle') {
  //   statusIndicator.classList.add('yellow');
  // } else if (statusData.Task === 'Off') {
  //   statusIndicator.classList.add('red');
  // }

  // Store the current values as previous values for the next update
  previousStatusData = statusData;
}

// Function to trigger the value change animation
function triggerValueChangeAnimation(element) {
  // Add the "value-change" class to the element
  element.classList.add('value-change');

  // Remove the "value-change" class after a delay
  setTimeout(() => {
    element.classList.remove('value-change');
  }, 1000); // Adjust the duration as needed (in milliseconds)
}

// Publish MQTT message
function publishMqttMessage(message) {
  client.publish(MQTT_TOPIC, message);
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
    updateSetTemperature(-1);
    disableButtonsTemporarily();
  }
});

tempIncreaseButton.addEventListener('click', () => {
  if (!buttonsDisabled) {
    updateSetTemperature(1);
    disableButtonsTemporarily();
  }
});

// Function to update the set temperature and publish the MQTT message
function updateSetTemperature(change) {
  const currentSetTemp = parseInt(setTemp.textContent, 10);
  const newSetTemp = currentSetTemp + change;

  // Check if the new set temperature is within the valid range
  if (newSetTemp >= 50 && newSetTemp <= 90) {
    setTemp.textContent = newSetTemp + '°';

    const message = `set-${newSetTemp}`;
    publishMqttMessage(message);
  }
}

// Flag to track button disable state
let buttonsDisabled = false;

// Function to disable buttons temporarily
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