# Air Conditioning Control App

The Air Conditioning Control App is a small Electron kiosk app for controlling an MQTT-connected air conditioner. It provides a touchscreen-friendly interface to adjust the setpoint, view the current operating state, and power the unit on or off.

## How It Works

The app communicates with the air conditioning unit using MQTT. The Electron main process owns the MQTT connection, subscribes to the configured status topics, and forwards safe UI updates to the renderer through a preload bridge.

The UI itself is plain HTML, CSS, and JavaScript. The renderer no longer talks to Node.js directly, which keeps the app aligned with current Electron security guidance.

## Setup

### Desktop / Development

1. Clone the repository: `git clone https://github.com/EthyMoney/AirConControl-Electron-MINI.git`
2. Install the required dependencies: `npm install`
3. Configure MQTT with environment variables before launch, if the defaults do not match your setup.
4. Start the app: `npm start`

### Raspberry Pi Kiosk (Pi 3 B+ / Pi Zero 2 W)

The installer handles everything — you do **not** need to clone the repo or run `npm install` yourself. Just copy `installer.sh` to the Pi and run it:

```bash
sudo ./installer.sh
```

The installer will:

- Install all system dependencies and the X11 kiosk stack
- Install Node.js LTS via `n`
- Clone this repository into `~/AirConControl-Electron-MINI`
- Run `npm install` inside the cloned app
- Configure LightDM autologin to Openbox
- Set up the Openbox autostart to launch the app on boot

The installer defaults to the native DSI display path and does not require third-party LCD driver scripts. If you are using an older SPI display, run:

```bash
DISPLAY_TYPE=spi sudo ./installer.sh
```

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
