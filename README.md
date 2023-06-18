# Air Conditioning Control App

The Air Conditioning Control App is a web application that allows you to remotely control your air conditioning unit. It provides a user interface to adjust the temperature, view the current status, and power on/off the air conditioner.

## How It Works

The app communicates with the air conditioning unit using the MQTT protocol. It connects to an MQTT broker and subscribes to a specific topic where the air conditioner publishes its status updates. The app sends control commands to the air conditioner by publishing messages to the same topic.

The app consists of a backend server implemented in Node.js and a frontend user interface built with HTML, CSS, and JavaScript. The backend server establishes the MQTT connection, handles MQTT messages, and updates the UI accordingly. The frontend UI allows users to interact with the air conditioning unit and displays the current status and temperature settings.

## Setup

To set up the Air Conditioning Control App, follow these steps:

1. Clone the repository: `git clone https://github.com/EthyMoney/AirConControl-Electron-MINI.git`
2. Install the required dependencies: `npm install`
3. Configure the MQTT broker URL and topic in the `renderer.js` file.
4. Build the frontend assets: `npm run build`
5. Start the server: `npm start`
6. Access the app in your web browser at `http://localhost:3000`

## Usage

1. Open the Air Conditioning Control App in your web browser.
2. The current status of the air conditioner will be displayed, along with the current temperature setting.
3. Use the temperature buttons to increase or decrease the desired temperature.
4. Click the power on/off buttons to turn the air conditioner on or off.
5. The app will automatically update the UI when the air conditioner sends status updates.
6. Enjoy controlling your air conditioner remotely!

## License

This project is licensed under the [MIT License](LICENSE).
