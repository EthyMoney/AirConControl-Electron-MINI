# Air Conditioning Control App

AirConControl is a small Electron kiosk app for controlling and monitoring an MQTT-connected air conditioner. It provides a touchscreen-friendly interface for the setpoint and power controls, current and outside conditions, connection/freshness status, hardware state, command confirmation, and daily climate-history reports.

## State model

The Electron main process owns one versioned state snapshot. MQTT connection health, air-conditioner telemetry, weather telemetry, Home Assistant bridge health, commands, and runtime storage are tracked independently. The renderer receives normalized snapshots through the sandboxed preload bridge and does not parse raw MQTT payloads.

The UI preserves last-known readings when telemetry becomes stale and shows their age instead of presenting stale data as a connection failure. Unknown tasks remain `Unknown`, malformed payloads are reported in their own domain, and controls are disabled until MQTT and air-conditioner telemetry are both healthy.

Commands progress through `pending`, `published`, and `confirmed` states. A command is confirmed only when a matching air-conditioner status arrives; otherwise it becomes `failed` or `timed-out`.

## MQTT protocol

For compatibility, commands and state default to the original `MQTT_TOPIC_AIRCON` topic. Separate command and retained state topics are recommended:

```text
MQTT_TOPIC_AIRCON_COMMAND=home/shop/aircon/command
MQTT_TOPIC_AIRCON_STATE=home/shop/aircon/state
```

Commands are `on`, `off`, `status`, and `set-NN`. Renderer-originated commands are allowlisted to `on`, `off`, and setpoints from 50–90°F. Commands use MQTT QoS 1; the device should publish its resulting state after applying a command.

An air-conditioner status is a JSON object containing at least one core field (`Task`, `Enabled`, `Temp`, or `SetTemp`). A typical full status is:

```json
{
  "Enabled": true,
  "Task": "cooling",
  "Temp": 74,
  "SetTemp": 72,
  "FanOn": true,
  "CompressorOn": true,
  "RuntimeMilliseconds": 180000
}
```

Supported runtime fields have explicit units: `RuntimeMilliseconds`, `RuntimeSeconds`, and `RuntimeMinutes`. The legacy `Runtime` field is interpreted as milliseconds when numeric and also accepts `HH:MM[:SS]` or text such as `1hr 15min`. Start timestamps should use `RuntimeStartedAt` or `StateSince` rather than overloading a numeric runtime.

Weather payloads require numeric `air_temperature` and `relative_humidity` fields.

## Home Assistant bridge

Home Assistant MQTT discovery is enabled by default. Point this app and Home Assistant's MQTT integration at the same broker; no Home Assistant YAML configuration is required when MQTT discovery is enabled there. On connection, AirConControl publishes a retained device discovery payload to:

```text
homeassistant/device/airconcontrol_shop/config
```

The discovered **Shop Climate Control** device contains:

| Entity | Purpose |
| --- | --- |
| Climate | Power, `off`/`cool` mode, target temperature, current temperature, and current HVAC action |
| Fan | Diagnostic fan state |
| Compressor | Diagnostic compressor state |
| Cooling runtime today | Observed cooling duration for the local calendar day |
| Last status | Timestamp of the latest validated device status |

Normalized state and availability are retained under `airconcontrol/shop`. Home Assistant commands use separate mode, power, and temperature command topics under that base topic, then pass through the same validation, broker acknowledgement, reported-state confirmation, and timeout handling as touchscreen commands. Commands are not retained and have a 30-second Home Assistant message-expiry interval.

The entity becomes unavailable when device telemetry is stale. An MQTT Last Will also publishes `offline` if the bridge disconnects unexpectedly. Discovery is republished after reconnecting and whenever Home Assistant publishes its default `online` birth message to `homeassistant/status`.

The default HVAC modes are `off` and `cool` because the underlying protocol currently exposes power and setpoint commands, but no command for selecting heat/cool equipment modes.

Bridge configuration:

```text
HOME_ASSISTANT_DISCOVERY_ENABLED=true
HOME_ASSISTANT_DISCOVERY_PREFIX=homeassistant
HOME_ASSISTANT_STATUS_TOPIC=homeassistant/status
HOME_ASSISTANT_DEVICE_ID=airconcontrol_shop
HOME_ASSISTANT_DEVICE_NAME=Shop Climate Control
HOME_ASSISTANT_BASE_TOPIC=airconcontrol/shop
HOME_ASSISTANT_STATE_INTERVAL_MS=60000
```

`HOME_ASSISTANT_DEVICE_ID` is normalized to lowercase letters, numbers, underscores, and hyphens. Keep it stable: changing it creates a new Home Assistant device. If an old ID must be removed, publish an empty retained payload to its old discovery topic.

## Climate-history reports

Reports are based on intervals between validated status observations. The compressor state is used when supplied; otherwise `Task: cooling` is used. The final interval is recorded when cooling transitions to idle/off, and the last observation is persisted so short restarts do not discard an open cooling interval.

Each reported day has two touchscreen views. **Temp** plots sampled current temperature through the day and shades the exact validated intervals where the compressor was running. Tapping the line shows the nearest sample's time, temperature, and cooling state. **Runtime** displays all 24 hourly runtime bars on a fixed 60-minute scale.

Temperature is sampled every five minutes by default and detailed temperature/cooling-interval history is retained for 90 days. These limits can be changed with `TEMPERATURE_HISTORY_SAMPLE_MS` and `DETAILED_HISTORY_RETENTION_DAYS`. Daily and hourly aggregate runtime is retained beyond the detailed-history window.

An unobserved interval is capped at `AIRCON_STALE_AFTER_MS`, then recorded as a coverage gap rather than guessed. Temperature lines break across long observation gaps. The report displays its generation time, local timezone, and gap count; durations under one minute display as seconds.

Runtime state is atomically stored in Electron's per-user data directory as `cooling-runtime-report.json`, with a backup. Existing `cooling-runtime-daily.json` and `cooling-runtime-hourly.json` files are imported automatically the first time the new store is created. Corrupt stores are preserved before recovery.

## Setup

### Desktop / development

1. Clone the repository.
2. Run `npm install`.
3. Configure MQTT using environment variables if the defaults do not match your system.
4. Run `npm start`.

Available environment variables are listed in `.env.example`:

- `MQTT_BROKER_URL`
- `MQTT_CLIENT_ID`
- `MQTT_USERNAME`
- `MQTT_PASSWORD`
- `MQTT_TOPIC_AIRCON` (legacy fallback for both topics)
- `MQTT_TOPIC_AIRCON_COMMAND`
- `MQTT_TOPIC_AIRCON_STATE`
- `MQTT_TOPIC_TEMPEST_STATS`
- `AIRCON_STALE_AFTER_MS`
- `WEATHER_STALE_AFTER_MS`
- `COMMAND_TIMEOUT_MS`
- `TEMPERATURE_HISTORY_SAMPLE_MS`
- `DETAILED_HISTORY_RETENTION_DAYS`
- `HOME_ASSISTANT_DISCOVERY_ENABLED`
- `HOME_ASSISTANT_DISCOVERY_PREFIX`
- `HOME_ASSISTANT_STATUS_TOPIC`
- `HOME_ASSISTANT_DEVICE_ID`
- `HOME_ASSISTANT_DEVICE_NAME`
- `HOME_ASSISTANT_BASE_TOPIC`
- `HOME_ASSISTANT_STATE_INTERVAL_MS`

Example:

```bash
MQTT_BROKER_URL=mqtt://192.168.1.10 \
MQTT_TOPIC_AIRCON_COMMAND=home/shop/aircon/command \
MQTT_TOPIC_AIRCON_STATE=home/shop/aircon/state \
npm start
```

Electron sandboxing is enabled by default. On a system that cannot provide either the Chromium SUID sandbox or unprivileged user namespaces, fix the host sandbox configuration where possible. A temporary diagnostic launch can use `npm start -- --no-sandbox`, but that weakens renderer isolation.

### Raspberry Pi kiosk

The installer handles the system packages, Node.js, repository checkout, dependencies, LightDM autologin, and Openbox kiosk startup:

```bash
sudo ./installer.sh
```

The native DSI display path is the default. For an older SPI display, use:

```bash
DISPLAY_TYPE=spi sudo ./installer.sh
```

## Development and verification

- `npm test` runs behavioral tests for telemetry validation, Home Assistant discovery/state/commands, runtime parsing, state isolation, command acknowledgement/timeouts, persistence, temperature sampling, cooling intervals, stale gaps, midnight allocation, and legacy migration.
- `npm run lint` checks all JavaScript entry points for syntax errors.
- `npm run package` builds an unpacked Electron bundle.
- `npm run dist` creates installable artifacts with electron-builder.

## License

This project is licensed under the [MIT License](LICENSE).
