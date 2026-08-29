#!/bin/bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly NODE_MAJOR="${NODE_MAJOR:-24}"
readonly N_VERSION="${N_VERSION:-10.2.0}"
readonly REPOSITORY_URL="${AIRCON_REPOSITORY_URL:-https://github.com/EthyMoney/AirConControl-Electron-MINI.git}"

MODE=""
TARGET_USER="${SUDO_USER:-}"
DISPLAY_TYPE="${DISPLAY_TYPE:-dsi}"
DRY_RUN=false
SYSTEM_UPGRADE=false
REBOOT_AFTER=false

usage() {
  cat <<'EOF'
Usage:
  sudo bash ./installer.sh install [options]
  sudo bash ./installer.sh update [options]
  sudo bash ./installer.sh repair [options]
  sudo bash ./installer.sh configure-power [options]

Modes:
  install          Provision a new kiosk, including boot/display configuration.
  update           Pull, run npm ci, and restart an already supervised app.
  repair           Repair packages, session files, service, permissions, and dependencies.
  configure-power  Install only the Raspberry Pi reboot/shutdown authorization policy.

Options:
  --user USER          Kiosk account. Required when not invoked through sudo by that user.
  --display TYPE       dsi or spi; used only by install (default: dsi).
  --system-upgrade     Run apt upgrade during install. Never implied by another mode.
  --reboot             Reboot after a successful install.
  --dry-run            Print the selected mode's scope without changing the machine.
  -h, --help           Show this help.

Examples:
  sudo bash ./installer.sh install --user logan --display dsi
  sudo bash ./installer.sh update --user logan
  sudo bash ./installer.sh repair --user logan
  sudo bash ./installer.sh configure-power --user logan
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log_section() {
  echo ""
  echo "====== $* ======"
  echo ""
}

while (($#)); do
  case "$1" in
    install|update|repair|configure-power)
      [ -z "$MODE" ] || die "Only one mode can be selected."
      MODE="$1"
      shift
      ;;
    --user)
      (($# >= 2)) || die "--user requires a value."
      TARGET_USER="$2"
      shift 2
      ;;
    --display)
      (($# >= 2)) || die "--display requires dsi or spi."
      DISPLAY_TYPE="$2"
      shift 2
      ;;
    --system-upgrade)
      SYSTEM_UPGRADE=true
      shift
      ;;
    --reboot)
      REBOOT_AFTER=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument '$1'. Run bash ./installer.sh --help for usage."
      ;;
  esac
done

[ -n "$MODE" ] || {
  usage >&2
  exit 2
}

if $SYSTEM_UPGRADE && [ "$MODE" != install ]; then
  die "--system-upgrade is available only with install."
fi
if $REBOOT_AFTER && [ "$MODE" != install ]; then
  die "--reboot is available only with install."
fi
if [ "$MODE" = install ] && [ "$DISPLAY_TYPE" != dsi ] && [ "$DISPLAY_TYPE" != spi ]; then
  die "Unsupported display '$DISPLAY_TYPE'. Use dsi or spi."
fi

if $DRY_RUN; then
  echo "Mode: $MODE"
  echo "User: ${TARGET_USER:-<required>}"
  case "$MODE" in
    install)
      echo "Scope: system packages, pinned Node.js, application, X11/LightDM, systemd user service, power policy, boot/display settings, and Plymouth"
      echo "System upgrade: $SYSTEM_UPGRADE"
      echo "Display: $DISPLAY_TYPE"
      echo "Reboot after completion: $REBOOT_AFTER"
      ;;
    update)
      echo "Scope: git pull --ff-only, npm ci, supervised application restart, and health report"
      ;;
    repair)
      echo "Scope: required packages, pinned Node.js, managed-file backups, X11/LightDM, systemd user service, power policy, npm ci, and health report"
      echo "Excluded: boot files, display drivers, Plymouth, apt upgrade, and reboot"
      ;;
    configure-power)
      echo "Scope: Raspberry Pi power policy and authorization health check only"
      ;;
  esac
  exit 0
fi

[[ $EUID -eq 0 ]] || die "Run this command with sudo."
[ -n "$TARGET_USER" ] || die "Specify the kiosk account with --user USER."
[ "$TARGET_USER" != root ] || die "The kiosk account cannot be root. Use --user with the desktop login account."
id -u "$TARGET_USER" >/dev/null 2>&1 || die "User '$TARGET_USER' does not exist."

readonly TARGET_UID="$(id -u "$TARGET_USER")"
readonly TARGET_GROUP="$(id -gn "$TARGET_USER")"
readonly USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ "$USER_HOME" != / ] || die "Could not determine a safe home directory for '$TARGET_USER'."

readonly APP_DIR="$USER_HOME/AirConControl-Electron-MINI"
readonly CONFIG_DIR="$USER_HOME/.config"
readonly APP_ENV_FILE="$CONFIG_DIR/aircon-control.env"
readonly OPENBOX_DIR="$CONFIG_DIR/openbox"
readonly AUTOSTART_FILE="$OPENBOX_DIR/autostart"
readonly XSESSION_FILE="$USER_HOME/.xsession"
readonly USER_SYSTEMD_DIR="$CONFIG_DIR/systemd/user"
readonly USER_SERVICE_FILE="$USER_SYSTEMD_DIR/aircon-control.service"
readonly LIGHTDM_CONF_DIR="/etc/lightdm/lightdm.conf.d"
readonly LIGHTDM_AUTLOGIN_FILE="$LIGHTDM_CONF_DIR/99-aircon-autologin.conf"
readonly OPENBOX_SESSION_FILE="/usr/share/xsessions/openbox.desktop"
readonly CALIBRATION_FILE="/etc/X11/xorg.conf.d/99-calibration.conf"
readonly LCD_SHOW_DIR="$USER_HOME/LCD-show"
readonly POWER_POLICY_FILE="/etc/polkit-1/rules.d/49-aircon-control-power.rules"
readonly BACKUP_ROOT="/var/backups/aircon-control"
readonly RUN_TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
readonly BACKUP_DIR="$BACKUP_ROOT/$RUN_TIMESTAMP"
readonly TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT

backup_file() {
  local source_path="$1"
  local relative_path destination_path
  [ -e "$source_path" ] || [ -L "$source_path" ] || return 0
  relative_path="${source_path#/}"
  destination_path="$BACKUP_DIR/$relative_path"
  mkdir -p "$(dirname "$destination_path")"
  cp -a -- "$source_path" "$destination_path"
  echo "Backed up $source_path to $destination_path"
}

install_managed_file() {
  local source_path="$1"
  local destination_path="$2"
  local mode="$3"
  local owner="$4"
  local group="$5"
  if [ -f "$destination_path" ] && cmp -s "$source_path" "$destination_path"; then
    chown "$owner:$group" "$destination_path"
    chmod "$mode" "$destination_path"
    return
  fi
  backup_file "$destination_path"
  install -D -o "$owner" -g "$group" -m "$mode" "$source_path" "$destination_path"
}

run_as_user() {
  runuser -u "$TARGET_USER" -- env \
    HOME="$USER_HOME" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

user_systemctl_available() {
  [ -S "/run/user/$TARGET_UID/bus" ]
}

user_systemctl() {
  runuser -u "$TARGET_USER" -- env \
    HOME="$USER_HOME" \
    XDG_RUNTIME_DIR="/run/user/$TARGET_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$TARGET_UID/bus" \
    PATH="/usr/local/bin:/usr/bin:/bin" \
    systemctl --user "$@"
}

detect_boot_config_file() {
  if [ -f /boot/firmware/config.txt ]; then
    echo /boot/firmware/config.txt
  else
    echo /boot/config.txt
  fi
}

detect_boot_cmdline_file() {
  if [ -f /boot/firmware/cmdline.txt ]; then
    echo /boot/firmware/cmdline.txt
  else
    echo /boot/cmdline.txt
  fi
}

ensure_config_line() {
  local file_path="$1"
  local line="$2"
  grep -Fqx "$line" "$file_path" || echo "$line" >> "$file_path"
}

ensure_cmdline_arg() {
  local file_path="$1"
  local arg="$2"
  tr ' ' '\n' < "$file_path" | grep -Fqx "$arg" || sed -i "1 s|$| ${arg}|" "$file_path"
}

install_required_packages() {
  log_section "Installing required packages"
  apt update
  apt install -y \
    git lightdm openbox python3-xdg polkitd \
    xserver-xorg xserver-xorg-core xserver-xorg-video-all xserver-xorg-input-all xserver-xorg-input-libinput \
    xinit x11-xserver-utils npm \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 \
    libdrm2 libgbm1 libasound2 libxkbcommon0 libxshmfence1
  if [ "$MODE" = install ]; then
    apt install -y plymouth plymouth-label
  fi
  if $SYSTEM_UPGRADE; then
    log_section "Performing explicitly requested system upgrade"
    apt upgrade -y
  fi
}

ensure_node_version() {
  local installed_major=""
  if command -v node >/dev/null 2>&1; then
    installed_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  fi
  if [ "$installed_major" = "$NODE_MAJOR" ]; then
    echo "Node.js $(node --version) already matches pinned major $NODE_MAJOR."
    return
  fi

  log_section "Installing pinned Node.js major $NODE_MAJOR"
  npm install --global "n@$N_VERSION"
  n "$NODE_MAJOR"
  hash -r
  [ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" = "$NODE_MAJOR" ] \
    || die "Node.js major $NODE_MAJOR was not installed successfully."
}

require_checkout() {
  [ -d "$APP_DIR/.git" ] || die "No checkout exists at $APP_DIR. Run install first."
}

assert_clean_checkout() {
  [ -z "$(run_as_user git -C "$APP_DIR" status --porcelain)" ] \
    || die "The checkout at $APP_DIR has local changes. Preserve or commit them before updating."
}

sync_checkout() {
  log_section "Synchronizing application checkout"
  if [ -d "$APP_DIR/.git" ]; then
    assert_clean_checkout
    run_as_user git -C "$APP_DIR" pull --ff-only
  else
    install -d -o "$TARGET_USER" -g "$TARGET_GROUP" "$USER_HOME"
    run_as_user git clone "$REPOSITORY_URL" "$APP_DIR"
  fi
}

install_dependencies() {
  log_section "Installing reproducible application dependencies"
  require_checkout
  local npm_path
  npm_path="$(command -v npm)"
  run_as_user "$npm_path" --prefix "$APP_DIR" ci
}

configure_environment() {
  install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0755 "$CONFIG_DIR"
  if [ ! -f "$APP_ENV_FILE" ]; then
    install -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0600 "$APP_DIR/.env.example" "$APP_ENV_FILE"
    echo "Created $APP_ENV_FILE. Review its MQTT settings before production use."
  else
    chown "$TARGET_USER:$TARGET_GROUP" "$APP_ENV_FILE"
    chmod 0600 "$APP_ENV_FILE"
  fi
}

configure_power_policy() {
  log_section "Configuring kiosk power controls"
  sed "s/@AIRCON_USER@/$TARGET_USER/g" \
    "$SCRIPT_DIR/deploy/49-aircon-control-power.rules.in" > "$TEMP_DIR/49-aircon-control-power.rules"
  install_managed_file \
    "$TEMP_DIR/49-aircon-control-power.rules" \
    "$POWER_POLICY_FILE" \
    0644 root root
  sleep 1
}

configure_session() {
  log_section "Configuring supervised X11 kiosk session"
  install -d -o "$TARGET_USER" -g "$TARGET_GROUP" -m 0755 "$OPENBOX_DIR" "$USER_SYSTEMD_DIR"
  install_managed_file "$SCRIPT_DIR/deploy/openbox-autostart" "$AUTOSTART_FILE" 0755 "$TARGET_USER" "$TARGET_GROUP"
  install_managed_file "$SCRIPT_DIR/deploy/xsession" "$XSESSION_FILE" 0755 "$TARGET_USER" "$TARGET_GROUP"
  install_managed_file "$SCRIPT_DIR/deploy/aircon-control.service" "$USER_SERVICE_FILE" 0644 "$TARGET_USER" "$TARGET_GROUP"
  install_managed_file "$SCRIPT_DIR/deploy/openbox.desktop" "$OPENBOX_SESSION_FILE" 0644 root root

  sed "s/@AIRCON_USER@/$TARGET_USER/g" \
    "$SCRIPT_DIR/deploy/99-aircon-autologin.conf.in" > "$TEMP_DIR/99-aircon-autologin.conf"
  install_managed_file "$TEMP_DIR/99-aircon-autologin.conf" "$LIGHTDM_AUTLOGIN_FILE" 0644 root root
  systemctl enable lightdm
  systemctl set-default graphical.target
}

configure_boot_and_display() {
  log_section "Configuring boot and $DISPLAY_TYPE display"
  local boot_config_file boot_cmdline_file
  boot_config_file="$(detect_boot_config_file)"
  boot_cmdline_file="$(detect_boot_cmdline_file)"
  [ -f "$boot_config_file" ] || die "Boot config was not found at $boot_config_file."
  [ -f "$boot_cmdline_file" ] || die "Boot command line was not found at $boot_cmdline_file."
  backup_file "$boot_config_file"
  backup_file "$boot_cmdline_file"

  sed -i 's/console=tty1/console=tty3/' "$boot_cmdline_file"
  ensure_cmdline_arg "$boot_cmdline_file" quiet
  ensure_cmdline_arg "$boot_cmdline_file" splash
  ensure_cmdline_arg "$boot_cmdline_file" plymouth.ignore-serial-consoles
  ensure_cmdline_arg "$boot_cmdline_file" logo.nologo
  ensure_cmdline_arg "$boot_cmdline_file" loglevel=3
  ensure_cmdline_arg "$boot_cmdline_file" vt.global_cursor_default=0

  raspi-config nonint do_boot_splash 0
  raspi-config nonint do_boot_behaviour B4
  if grep -Fqx 'dtoverlay=vc4-fkms-v3d' "$boot_config_file"; then
    sed -i 's/^dtoverlay=vc4-fkms-v3d$/dtoverlay=vc4-kms-v3d/' "$boot_config_file"
  else
    ensure_config_line "$boot_config_file" 'dtoverlay=vc4-kms-v3d'
  fi
  if grep -Eq '^disable_splash=' "$boot_config_file"; then
    sed -i 's/^disable_splash=.*/disable_splash=1/' "$boot_config_file"
  else
    ensure_config_line "$boot_config_file" 'disable_splash=1'
  fi

  if [ "$DISPLAY_TYPE" = dsi ]; then
    apt install -y libinput-tools
    backup_file "$CALIBRATION_FILE"
    rm -f -- "$CALIBRATION_FILE"
    ensure_config_line "$boot_config_file" 'display_auto_detect=1'
  else
    install -d -o "$TARGET_USER" -g "$TARGET_GROUP" "$USER_HOME"
    if [ ! -d "$LCD_SHOW_DIR/.git" ]; then
      run_as_user git clone https://github.com/goodtft/LCD-show.git "$LCD_SHOW_DIR"
    fi
    chmod -R 0755 "$LCD_SHOW_DIR"
    sed -i -e 's/sudo reboot//' "$LCD_SHOW_DIR/LCD35-show"
    (cd "$LCD_SHOW_DIR" && ./LCD35-show)
    cp "$LCD_SHOW_DIR/xinput-calibrator_0.7.5-1_armhf.deb" "$USER_HOME/"
    apt install -y libc6 libgcc1 libstdc++6 libx11-6 libxext6 libxi6
    dpkg -i -B "$USER_HOME/xinput-calibrator_0.7.5-1_armhf.deb"
    backup_file "$CALIBRATION_FILE"
    install -D -m 0644 "$SCRIPT_DIR/deploy/99-calibration.conf" "$CALIBRATION_FILE"
    sed -i -e 's/dtoverlay=tft35a:rotate=90/dtoverlay=tft35a:rotate=90,speed=24000000,fps=60/' "$boot_config_file"
  fi
  update-initramfs -u
}

terminate_matching_processes() {
  local pattern="$1"
  local label="$2"
  local -a pids=()
  mapfile -t pids < <(pgrep -u "$TARGET_UID" -f "$pattern" || true)
  ((${#pids[@]})) || return 0
  echo "Stopping legacy $label process(es): ${pids[*]}"
  kill -TERM "${pids[@]}" 2>/dev/null || true
  for _attempt in {1..20}; do
    local -a remaining=()
    for pid in "${pids[@]}"; do
      kill -0 "$pid" 2>/dev/null && remaining+=("$pid")
    done
    ((${#remaining[@]} == 0)) && return 0
    pids=("${remaining[@]}")
    sleep 0.5
  done
  echo "Legacy $label did not stop gracefully; forcing only: ${pids[*]}"
  kill -KILL "${pids[@]}" 2>/dev/null || true
}

stop_running_app() {
  if ! user_systemctl_available; then
    return
  fi

  user_systemctl stop aircon-control.service >/dev/null 2>&1 || true
  terminate_matching_processes "^(sh|bash) $AUTOSTART_FILE$" "Openbox restart loop"
  terminate_matching_processes "^node $APP_DIR/node_modules/\.bin/electron \. *$" "Electron launcher"
  terminate_matching_processes "^$APP_DIR/node_modules/electron/dist/electron \. *$" "Electron main"
}

restart_supervised_app() {
  log_section "Starting supervised application"
  if ! user_systemctl_available; then
    echo "No active user session bus exists for $TARGET_USER; Openbox will start the service at the next graphical login."
    return
  fi

  user_systemctl daemon-reload
  user_systemctl restart aircon-control.service
}

power_capability() {
  local method="$1"
  runuser -u "$TARGET_USER" -- busctl call \
    org.freedesktop.login1 \
    /org/freedesktop/login1 \
    org.freedesktop.login1.Manager \
    "$method" 2>/dev/null | sed -E 's/^s "(.*)"$/\1/' || echo unavailable
}

health_report() {
  local renderer_command=""
  log_section "Installation health report"
  echo "User: $TARGET_USER ($TARGET_UID)"
  echo "App directory: $APP_DIR"
  if [ -r /proc/device-tree/model ]; then
    echo "Hardware: $(tr -d '\0' < /proc/device-tree/model)"
  else
    echo "Hardware: not reported by device tree"
  fi
  if [ -d "$APP_DIR/.git" ]; then
    echo "Git revision: $(run_as_user git -C "$APP_DIR" rev-parse --short HEAD)"
    echo "Checkout clean: $([ -z "$(run_as_user git -C "$APP_DIR" status --porcelain)" ] && echo yes || echo no)"
  fi
  command -v node >/dev/null 2>&1 && echo "Node.js: $(node --version)"
  command -v npm >/dev/null 2>&1 && echo "npm: $(npm --version) ($(command -v npm))"
  if [ -f "$APP_DIR/node_modules/electron/package.json" ]; then
    echo "Electron: $(node -p "require('$APP_DIR/node_modules/electron/package.json').version")"
  fi
  if [ -f "$APP_DIR/system-power.js" ]; then
    echo "Raspberry Pi detected by app: $(run_as_user node -p "require('$APP_DIR/system-power').isRaspberryPi()")"
  fi
  if user_systemctl_available && [ -f "$USER_SERVICE_FILE" ]; then
    echo "Application service: $(user_systemctl is-active aircon-control.service 2>/dev/null || true)"
  else
    echo "Application service: waiting for graphical login"
  fi
  renderer_command="$(pgrep -u "$TARGET_UID" -af -- '--type=renderer' | head -n 1 || true)"
  if [ -n "$renderer_command" ]; then
    echo "Renderer Pi capability flag: $([[ "$renderer_command" == *--raspberry-pi* ]] && echo yes || echo no)"
  else
    echo "Renderer Pi capability flag: renderer not running"
  fi
  command -v systemctl >/dev/null 2>&1 && echo "LightDM enabled: $(systemctl is-enabled lightdm 2>/dev/null || true)"
  if [ -f "$POWER_POLICY_FILE" ]; then
    echo "Reboot authorization: $(power_capability CanReboot)"
    echo "Power-off authorization: $(power_capability CanPowerOff)"
  fi
  if [ -d "$BACKUP_DIR" ]; then
    echo "Backups: $BACKUP_DIR"
  fi
  echo "Managed file ownership:"
  for managed_file in "$APP_ENV_FILE" "$AUTOSTART_FILE" "$XSESSION_FILE" "$USER_SERVICE_FILE" "$POWER_POLICY_FILE"; do
    [ -e "$managed_file" ] && stat -c '  %U:%G %a %n' "$managed_file"
  done
}

run_install() {
  install_required_packages
  ensure_node_version
  sync_checkout
  stop_running_app
  install_dependencies
  configure_environment
  configure_session
  configure_power_policy
  configure_boot_and_display
  log_section "Installing boot splash"
  DISPLAY_TYPE="$DISPLAY_TYPE" bash "$APP_DIR/plymouth/install-theme.sh"
  restart_supervised_app
  health_report
  if $REBOOT_AFTER; then
    systemctl reboot
  else
    echo "Full provisioning completed. Reboot when convenient to apply boot/display changes."
  fi
}

run_update() {
  require_checkout
  [ -f "$USER_SERVICE_FILE" ] || die "The supervised service is not installed. Run repair once before using update."
  sync_checkout
  stop_running_app
  install_dependencies
  restart_supervised_app
  health_report
}

run_repair() {
  require_checkout
  install_required_packages
  ensure_node_version
  stop_running_app
  chown -R "$TARGET_USER:$TARGET_GROUP" "$APP_DIR"
  install_dependencies
  configure_environment
  configure_session
  configure_power_policy
  restart_supervised_app
  health_report
  echo "Repair completed without changing boot files, display drivers, or Plymouth."
}

case "$MODE" in
  install) run_install ;;
  update) run_update ;;
  repair) run_repair ;;
  configure-power)
    configure_power_policy
    health_report
    ;;
esac
