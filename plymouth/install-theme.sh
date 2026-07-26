#!/bin/bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root: sudo ./plymouth/install-theme.sh" >&2
  exit 1
fi

THEME_NAME="aircon-control"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/$THEME_NAME"
TARGET_DIR="/usr/share/plymouth/themes/$THEME_NAME"
DISPLAY_TYPE="${DISPLAY_TYPE:-dsi}"
INITRAMFS_MODULES_FILE="/etc/initramfs-tools/modules"

detect_boot_config_file() {
  if [[ -f /boot/firmware/config.txt ]]; then
    echo /boot/firmware/config.txt
    return
  fi

  echo /boot/config.txt
}

detect_boot_cmdline_file() {
  if [[ -f /boot/firmware/cmdline.txt ]]; then
    echo /boot/firmware/cmdline.txt
    return
  fi

  echo /boot/cmdline.txt
}

ensure_config_setting() {
  local file_path="$1"
  local key="$2"
  local value="$3"

  if grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$file_path"; then
    sed -i -E "s|^[[:space:]]*${key}[[:space:]]*=.*$|${key}=${value}|g" "$file_path"
  else
    echo "${key}=${value}" >> "$file_path"
  fi
}

ensure_cmdline_arg() {
  local file_path="$1"
  local arg="$2"

  if ! tr ' ' '\n' < "$file_path" | grep -Fqx "$arg"; then
    sed -i "1 s|$| $arg|" "$file_path"
  fi
}

ensure_initramfs_module() {
  local module_name="$1"

  if ! grep -Eq "^[[:space:]]*${module_name}([[:space:]]|$)" "$INITRAMFS_MODULES_FILE"; then
    echo "$module_name" >> "$INITRAMFS_MODULES_FILE"
  fi
}

BOOT_CONFIG_FILE="$(detect_boot_config_file)"
BOOT_CMDLINE_FILE="$(detect_boot_cmdline_file)"

for required_file in background.png dot-bright.png dot-dim.png "$THEME_NAME.plymouth" "$THEME_NAME.script"; do
  if [[ ! -f "$SOURCE_DIR/$required_file" ]]; then
    echo "Missing Plymouth asset: $SOURCE_DIR/$required_file" >&2
    exit 1
  fi
done

# Suppress the Raspberry Pi firmware's rainbow test card and keep the console
# quiet while Plymouth owns the framebuffer.
ensure_config_setting "$BOOT_CONFIG_FILE" disable_splash 1
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" quiet
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" splash
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" plymouth.ignore-serial-consoles
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" logo.nologo
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" loglevel=3
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" vt.global_cursor_default=0

# MODULES=dep does not discover the native DSI bridge while building the
# initramfs. Force the complete display chain to load before Plymouth starts.
if [[ "$DISPLAY_TYPE" == "dsi" ]]; then
  ensure_initramfs_module i2c_bcm2835
  ensure_initramfs_module rpi_panel_attiny_regulator
  ensure_initramfs_module tc358762
  ensure_initramfs_module vc4
fi

install -d -m 0755 "$TARGET_DIR"
install -m 0644 "$SOURCE_DIR/background.png" "$TARGET_DIR/background.png"
install -m 0644 "$SOURCE_DIR/dot-bright.png" "$TARGET_DIR/dot-bright.png"
install -m 0644 "$SOURCE_DIR/dot-dim.png" "$TARGET_DIR/dot-dim.png"
install -m 0644 "$SOURCE_DIR/$THEME_NAME.plymouth" "$TARGET_DIR/$THEME_NAME.plymouth"
install -m 0644 "$SOURCE_DIR/$THEME_NAME.script" "$TARGET_DIR/$THEME_NAME.script"

plymouth-set-default-theme "$THEME_NAME"
update-initramfs -u

echo "Installed Plymouth theme '$THEME_NAME' and configured the boot display."
echo "The changes will appear on the next boot."
