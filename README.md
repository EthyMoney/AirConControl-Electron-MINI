# Air Conditioning Control App

The Air Conditioning Control App is a small Electron kiosk app for controlling an MQTT-connected air conditioner. It provides a touchscreen-friendly interface to adjust the setpoint, view the current operating state, and power the unit on or off.

## How It Works

The app communicates with the air conditioning unit using MQTT. The Electron main process owns the MQTT connection, subscribes to the configured status topics, and forwards safe UI updates to the renderer through a preload bridge.

The UI itself is plain HTML, CSS, and JavaScript. The renderer no longer talks to Node.js directly, which keeps the app aligned with current Electron security guidance.

## Setup

To set up the Air Conditioning Control App, follow these steps:

1. Clone the repository: `git clone https://github.com/EthyMoney/AirConControl-Electron-MINI.git`
2. Install the required dependencies: `npm install`
3. Configure MQTT with environment variables before launch, if the defaults do not match your setup.
4. Start the app: `npm start`
5. For a Raspberry Pi Zero 2 W running Raspberry Pi OS Lite x64 Trixie with a 5 inch 800x480 DSI touchscreen, run `sudo ./installer.sh`. The installer now defaults to the native DSI display path and does not use third-party LCD driver scripts for that setup.
6. If you still need the older SPI display flow, run the installer with `DISPLAY_TYPE=spi sudo ./installer.sh`.

Supported environment variables are listed in `.env.example`:

- `MQTT_BROKER_URL`
- `MQTT_TOPIC_AIRCON`
- `MQTT_TOPIC_TEMPEST_STATS`

Example:

```bash
MQTT_BROKER_URL=mqtt://192.168.1.10 MQTT_TOPIC_AIRCON=home/shop/aircon npm start
```

## Usage

1. Launch the Electron app.
2. The current status of the air conditioner will be displayed, along with the current temperature setting.
3. Use the temperature buttons to increase or decrease the desired temperature.
4. Click the power on/off buttons to turn the air conditioner on or off.
5. The app will automatically update the UI when the air conditioner sends status updates.
6. Enjoy controlling your air conditioner remotely!

## Development

- `npm run lint` checks the JavaScript entry points for syntax errors.
- `npm run package` builds an unpacked Electron bundle.
- `npm run dist` creates installable artifacts with electron-builder.

## License

This project is licensed under the [MIT License](LICENSE).
