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

Every HA-capable instance continuously watches the retained MQTT 5 ownership lease at
`airconcontrol/shop/bridge/owner`. One instance is elected leader and refreshes the lease;
the others stay connected as standbys while retaining normal controls and telemetry. A cleanly
stopped leader clears the lease for immediate takeover. If it crashes or loses the broker, its
MQTT 5 message expiry removes the abandoned lease after 30 seconds and a standby automatically
takes over. A leader-only MQTT Last Will marks the HA device offline during that gap. Losing
ownership disables HA commands and publishing immediately.

MQTT client IDs include the stable instance ID and process ID so ordinary connections cannot
evict one another. Set a unique, stable `AIRCON_INSTANCE_ID` on every device; the hostname is
used by default.

The discovered **Shop Climate Control** device contains:

| Entity | Purpose |
| --- | --- |
| Climate | Power, `off`/`cool` mode, target temperature, current temperature, and current HVAC action |
| Fan | Diagnostic fan state |
| Compressor | Diagnostic compressor state |
| Cooling runtime today | Observed cooling duration for the local calendar day |
| Last status | Timestamp of the latest validated device status |
| Bridge instance | Stable ID of the elected bridge |
| Bridge version | Running application version |
| Runtime source | Instance that published shared climate history |

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
HOME_ASSISTANT_LEASE_TOPIC=airconcontrol/shop/bridge/owner
HOME_ASSISTANT_LEASE_DURATION_MS=30000
```

`HOME_ASSISTANT_DEVICE_ID` is normalized to lowercase letters, numbers, underscores, and hyphens. Keep it stable: changing it creates a new Home Assistant device. If an old ID must be removed, publish an empty retained payload to its old discovery topic.

## Climate-history reports

Reports are based on intervals between validated status observations. The compressor state is used when supplied; otherwise `Task: cooling` is used. The final interval is recorded when cooling transitions to idle/off, and the last observation is persisted so short restarts do not discard an open cooling interval.

Each reported day has two touchscreen views. **Temp** plots sampled current temperature through the day and shades the exact validated intervals where the compressor was running. Tapping the line shows the nearest sample's time, temperature, and cooling state. **Runtime** displays all 24 hourly runtime bars on a fixed 60-minute scale.

Temperature is sampled every five minutes by default and detailed temperature/cooling-interval history is retained for 90 days. These limits can be changed with `TEMPERATURE_HISTORY_SAMPLE_MS` and `DETAILED_HISTORY_RETENTION_DAYS`. Daily and hourly aggregate runtime is retained beyond the detailed-history window.

The elected bridge publishes its complete report as a gzip-compressed retained MQTT payload at
`airconcontrol/shop/runtime/report` every five minutes and whenever leadership changes. Standbys
display that shared report, so all screens use one history source. Each instance still records a
local copy for resilience; a newly elected leader publishes its local observations as the new
shared source. The Climate History header identifies the active source.

An unobserved interval is capped at `AIRCON_STALE_AFTER_MS`, then recorded as a coverage gap rather than guessed. Once that deadline passes the display keeps re-requesting a status every `AIRCON_STALE_RETRY_MS` until one arrives. Temperature lines break across long observation gaps. The report displays its generation time, local timezone, and gap count; durations under one minute display as seconds.

Runtime state is atomically stored in Electron's per-user data directory as `cooling-runtime-report.json`, with a backup. The file is written whole on every save, so saves are coalesced into a `RUNTIME_SAVE_INTERVAL_MS` window (30s) rather than issued per status message — this matters on a Pi, where the store approaches 1 MB at full retention and the SD card pays for every rewrite. Cooling transitions decide how runtime is attributed and are flushed within `RUNTIME_CRITICAL_SAVE_MS` instead of waiting out that window, and the `.bak` recovery point is refreshed on its own `RUNTIME_BACKUP_INTERVAL_MS` cadence (1h) so a routine save does not write the data twice. A crash can therefore lose at most one save window of the open interval. Writes are `fsync`ed before the atomic rename. Existing `cooling-runtime-daily.json` and `cooling-runtime-hourly.json` files are imported automatically the first time the new store is created. Corrupt stores are preserved before recovery.

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
- `MQTT_CA_FILE`
- `MQTT_CERT_FILE`
- `MQTT_KEY_FILE`
- `MQTT_TLS_REJECT_UNAUTHORIZED`
- `MQTT_TOPIC_AIRCON` (legacy fallback for both topics)
- `MQTT_TOPIC_AIRCON_COMMAND`
- `MQTT_TOPIC_AIRCON_STATE`
- `MQTT_TOPIC_TEMPEST_STATS`
- `AIRCON_STALE_AFTER_MS`
- `AIRCON_STALE_RETRY_MS`
- `WEATHER_STALE_AFTER_MS`
- `COMMAND_TIMEOUT_MS`
- `TEMPERATURE_HISTORY_SAMPLE_MS`
- `DETAILED_HISTORY_RETENTION_DAYS`
- `RUNTIME_SAVE_INTERVAL_MS`
- `RUNTIME_CRITICAL_SAVE_MS`
- `RUNTIME_BACKUP_INTERVAL_MS`
- `AIRCON_INSTANCE_ID`
- `AIRCON_FLEET_TOPIC`
- `AIRCON_FLEET_STATUS_INTERVAL_MS`
- `SHARED_RUNTIME_TOPIC`
- `SHARED_RUNTIME_INTERVAL_MS`
- `HOME_ASSISTANT_DISCOVERY_ENABLED`
- `HOME_ASSISTANT_DISCOVERY_PREFIX`
- `HOME_ASSISTANT_STATUS_TOPIC`
- `HOME_ASSISTANT_DEVICE_ID`
- `HOME_ASSISTANT_DEVICE_NAME`
- `HOME_ASSISTANT_BASE_TOPIC`
- `HOME_ASSISTANT_STATE_INTERVAL_MS`
- `HOME_ASSISTANT_LEASE_TOPIC`
- `HOME_ASSISTANT_LEASE_DURATION_MS`

Example:

```bash
MQTT_BROKER_URL=mqtt://192.168.1.10 \
MQTT_TOPIC_AIRCON_COMMAND=home/shop/aircon/command \
MQTT_TOPIC_AIRCON_STATE=home/shop/aircon/state \
npm start
```

For TLS, use an `mqtts://` broker URL and point `MQTT_CA_FILE` at the CA certificate. Set
`MQTT_CERT_FILE` and `MQTT_KEY_FILE` as well when the broker requires mutual TLS. Certificate
validation defaults to enabled; `MQTT_TLS_REJECT_UNAUTHORIZED=false` is only suitable for a
temporary test with a self-signed broker.

Every instance retains its hostname, app version, MQTT status, HA role, and runtime source at
`airconcontrol/shop/instances/<instance-id>/status`. Its MQTT Last Will changes that record to
`offline`. These records make outdated or disconnected devices visible with any MQTT client.

Recommended broker permissions for the app account are read access to air-conditioner state,
weather state, HA birth/command topics, the lease, shared runtime, and fleet topics; write access
to air-conditioner commands, HA discovery/state/availability, the lease, shared runtime, and its
fleet status. Deny unrelated topics. Prefer a distinct credential per device even when their ACLs
are identical, and do not place credentials in the repository.

Electron sandboxing is enabled by default. On a system that cannot provide either the Chromium SUID sandbox or unprivileged user namespaces, fix the host sandbox configuration where possible. A temporary diagnostic launch can use `npm start -- --no-sandbox`, but that weakens renderer isolation.

### Raspberry Pi kiosk

The installer handles the system packages, Node.js, repository checkout, dependencies, LightDM autologin, and Openbox kiosk startup:

```bash
sudo ./installer.sh
```

On first installation it creates `~/.config/aircon-control.env` from `.env.example`, restricts it
to the kiosk user (`0600`), and loads it before each app start. Configure each Pi's unique
`AIRCON_INSTANCE_ID`, broker credentials, and TLS certificate paths there. Updates preserve this
file.

On Raspberry Pi hardware, a power icon appears beside the humidity reading. It opens large
touchscreen actions for restarting or shutting down the Pi. The installer adds a narrowly scoped
polkit rule so only the kiosk user can invoke those two system actions without an authentication
prompt. The button stays hidden on desktop builds and non-Pi Linux systems.

The native DSI display path is the default. For an older SPI display, use:

```bash
DISPLAY_TYPE=spi sudo ./installer.sh
```

### Windows desktop build

The default build is a touchscreen kiosk: fullscreen, frameless, with the mouse cursor hidden. A desktop build runs the same app in a normal 800×480 window with a title bar, a visible cursor, and button hover feedback:

```bash
npm run start:desktop        # run it from source
npm run dist:win:desktop     # build a Windows installer into dist-desktop/
npm run package:win:desktop  # unpacked bundle only, into dist-desktop/win-unpacked/
```

Desktop mode is selected by the `--desktop` argument, the `AIRCON_DESKTOP_MODE` environment variable, or the `airconDesktopMode` flag that the two build scripts bake into the packaged app. The kiosk build is unaffected.

A desktop copy is meant to run **alongside** the always-on wall display, so it defaults to staying out of the wall display's way:

- **The Home Assistant bridge is off.** Discovery, state, and availability are retained topics with a single owner; two publishers would fight over them, and the desktop app closing would publish `offline` and knock the entity out. Set `HOME_ASSISTANT_DISCOVERY_ENABLED=1` to override this if you are running a desktop copy on its own.
- **The MQTT client ID gets a `_desktop` suffix plus a per-host/process suffix.** Brokers evict the older session when a second client connects with the same ID, so every running instance needs its own final ID.

Both instances still read the same MQTT topics and can send commands. Their local history remains
in each per-user data directory, while the elected bridge supplies the shared report shown across
the fleet.

### Fleet rollout and failover check

1. Stop or disable HA bridging on every old version; old builds do not honor the lease.
2. Deploy this version to all devices and assign each a distinct `AIRCON_INSTANCE_ID`.
3. Start one device, then the rest. Confirm exactly one retained lease and one `leader` status.
4. Stop the leader. A standby should become leader immediately after a clean stop, or within the
  configured lease duration after a crash.
5. Confirm Home Assistant's Bridge instance/version sensors change to the new owner and every
  fleet status reports the expected app version.

### Boot splash

The Raspberry Pi installer enables the bundled **Shop Climate Control** Plymouth theme automatically. It includes an 800×480 cooling-themed splash and a lightweight three-dot startup animation designed for the Pi 3. The theme scales and center-crops safely if a different framebuffer size is detected.

To install or refresh only the boot theme on an existing kiosk:

```bash
sudo ./plymouth/install-theme.sh
```

The installer selects `aircon-control` as the default theme, disables the Raspberry Pi firmware rainbow screen, adds the native DSI display modules required during early boot, and rebuilds the initramfs. Reboot to see it. The boot command line must contain `quiet splash plymouth.ignore-serial-consoles`; the installer adds these arguments and hides the text cursor.

The checked-in PNGs are ready to deploy. If the source artwork or dot design is changed, regenerate them after `npm install` with:

```bash
npm run render:plymouth
```

## Development and verification

- `npm test` runs behavioral tests for telemetry validation, Home Assistant discovery/state/commands, runtime parsing, state isolation, command acknowledgement/timeouts, persistence, temperature sampling, cooling intervals, stale gaps, midnight allocation, and legacy migration.
- `npm run lint` checks all JavaScript entry points for syntax errors.
- `npm run package` builds an unpacked Electron bundle.
- `npm run dist` creates installable artifacts with electron-builder.
- `npm run dist:win:desktop` creates the windowed, mouse-friendly Windows build described above.

## License

This project is licensed under the [MIT License](LICENSE).
