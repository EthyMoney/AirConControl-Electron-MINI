#!/bin/bash
set -euo pipefail

USERNAME="${SUDO_USER:-${USER:-pi}}"
DISPLAY_TYPE="${DISPLAY_TYPE:-dsi}"
APP_DIR="/home/$USERNAME/AirConControl-Electron-MINI"
CONFIG_DIR="/home/$USERNAME/.config"
OPENBOX_DIR="$CONFIG_DIR/openbox"
AUTOSTART_FILE="$OPENBOX_DIR/autostart"
XSESSION_FILE="/home/$USERNAME/.xsession"
PICOM_CONF="$CONFIG_DIR/picom.conf"
LIGHTDM_CONF_DIR="/etc/lightdm/lightdm.conf.d"
LIGHTDM_AUTLOGIN_FILE="$LIGHTDM_CONF_DIR/99-aircon-autologin.conf"
CALIBRATION_FILE="/etc/X11/xorg.conf.d/99-calibration.conf"
LCD_SHOW_DIR="/home/$USERNAME/LCD-show"

detect_boot_config_file() {
  if [ -f /boot/firmware/config.txt ]; then
    echo /boot/firmware/config.txt
    return
  fi

  echo /boot/config.txt
}

detect_boot_cmdline_file() {
  if [ -f /boot/firmware/cmdline.txt ]; then
    echo /boot/firmware/cmdline.txt
    return
  fi

  echo /boot/cmdline.txt
}

ensure_config_line() {
  local file_path="$1"
  local line="$2"

  if ! grep -Fqx "$line" "$file_path"; then
    echo "$line" >> "$file_path"
  fi
}

ensure_cmdline_arg() {
  local file_path="$1"
  local arg="$2"

  if ! grep -Eq "(^| )${arg}( |$)" "$file_path"; then
    sed -i "1 s|$| ${arg}|" "$file_path"
  fi
}

BOOT_CONFIG_FILE="$(detect_boot_config_file)"
BOOT_CMDLINE_FILE="$(detect_boot_cmdline_file)"

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root"
  exit 1
fi

echo ""
echo "======================= Minimal Display Manager With Single Application Kiosk Installer For Raspberry Pi ======================="
echo ""
echo "====== Running Pre-Installation Checks ======"
echo ""

if ! ping -q -c 1 -W 1 google.com >/dev/null; then
  echo "The internet is not reachable. Please check your network connection and try again."
  exit 1
fi

if ! id -u "$USERNAME" >/dev/null 2>&1; then
  echo "The configured username '$USERNAME' does not exist. Create the user or re-run the script with sudo from the target account."
  exit 1
fi

if [[ "$DISPLAY_TYPE" != "dsi" && "$DISPLAY_TYPE" != "spi" ]]; then
  echo "Unsupported DISPLAY_TYPE '$DISPLAY_TYPE'. Use DISPLAY_TYPE=dsi or DISPLAY_TYPE=spi."
  exit 1
fi

echo "Pre-installation checks passed. Proceeding with installation..."
echo ""
echo "====== Performing System Update ======"
echo ""

apt update
apt upgrade -y

echo ""
echo "====== Installing APT Packages ======"
echo ""

apt install -y \
  vnstat neofetch git lightdm picom net-tools \
  xserver-xorg xserver-xorg-core xserver-xorg-video-all xserver-xorg-input-all xserver-xorg-input-libinput \
  xinit x11-xserver-utils openbox npm wavemon \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libdrm2 libgbm1 libasound2 libxkbcommon0 libxshmfence1

echo ""
echo "====== Installing Updated Node.js and NPM + Global Packages ======"
echo ""

npm i -g n
n lts
export PATH="/usr/local/bin:$PATH"
hash -r
npm i -g npm npm-check-updates eslint ts-node typescript pm2
hash -r

echo ""
echo "====== Configuring X11 Kiosk Session ======"
echo ""

mkdir -p "$OPENBOX_DIR"
echo '#!/bin/bash' > "$AUTOSTART_FILE"
echo '' >> "$AUTOSTART_FILE"
echo 'xset s off' >> "$AUTOSTART_FILE"
echo 'xset -dpms' >> "$AUTOSTART_FILE"
echo 'xset s noblank' >> "$AUTOSTART_FILE"
echo 'picom -b &' >> "$AUTOSTART_FILE"
echo 'export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' >> "$AUTOSTART_FILE"
echo 'while true; do' >> "$AUTOSTART_FILE"
echo '  echo "Starting application..."' >> "$AUTOSTART_FILE"
echo "  cd \"$APP_DIR\"" >> "$AUTOSTART_FILE"
echo '  npm start' >> "$AUTOSTART_FILE"
echo '  sleep 5' >> "$AUTOSTART_FILE"
echo 'done &' >> "$AUTOSTART_FILE"
chmod +x "$AUTOSTART_FILE"

echo '#!/bin/bash' > "$XSESSION_FILE"
echo 'xset s off' >> "$XSESSION_FILE"
echo 'xset -dpms' >> "$XSESSION_FILE"
echo 'xset s noblank' >> "$XSESSION_FILE"
echo 'exec openbox-session' >> "$XSESSION_FILE"
chmod +x "$XSESSION_FILE"
chown "$USERNAME:$USERNAME" "$XSESSION_FILE"

echo ""
echo "Openbox autostart and X11 session configured."
echo ""
echo "====== Configuring LightDM Autologin ======"
echo ""

mkdir -p "$LIGHTDM_CONF_DIR"
echo '[Seat:*]' > "$LIGHTDM_AUTLOGIN_FILE"
echo "autologin-user=$USERNAME" >> "$LIGHTDM_AUTLOGIN_FILE"
echo 'autologin-user-timeout=0' >> "$LIGHTDM_AUTLOGIN_FILE"
echo 'user-session=openbox' >> "$LIGHTDM_AUTLOGIN_FILE"
echo 'autologin-session=openbox' >> "$LIGHTDM_AUTLOGIN_FILE"

mkdir -p /usr/share/xsessions
if [ ! -f /usr/share/xsessions/openbox.desktop ]; then
  cat > /usr/share/xsessions/openbox.desktop << 'EOF'
[Desktop Entry]
Name=Openbox
Comment=Openbox window manager
Exec=openbox-session
TryExec=openbox-session
Type=XSession
EOF
fi

systemctl enable lightdm
systemctl set-default graphical.target

echo ""
echo "LightDM autologin configured."
echo ""
echo "====== Processing Pi Configuration Special Triggers ======"
echo ""

sed -i 's/console=tty1/console=tty3/' "$BOOT_CMDLINE_FILE"
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" quiet
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" splash
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" plymouth.ignore-serial-consoles
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" logo.nologo
ensure_cmdline_arg "$BOOT_CMDLINE_FILE" loglevel=3

raspi-config nonint do_boot_splash 0
raspi-config nonint do_boot_behaviour B4

if grep -Fqx 'dtoverlay=vc4-fkms-v3d' "$BOOT_CONFIG_FILE"; then
  sed -i 's/^dtoverlay=vc4-fkms-v3d$/dtoverlay=vc4-kms-v3d/' "$BOOT_CONFIG_FILE"
else
  ensure_config_line "$BOOT_CONFIG_FILE" 'dtoverlay=vc4-kms-v3d'
fi

echo 'vsync = true;' > "$PICOM_CONF"
echo 'backend = "glx";' >> "$PICOM_CONF"
echo 'fading = false;' >> "$PICOM_CONF"
echo "shadow-exclude = [ \"name = 'cursor'\" ];" >> "$PICOM_CONF"

update-initramfs -u
chown -R "$USERNAME:$USERNAME" "$CONFIG_DIR"

echo ""
echo "Configuration triggers complete."
echo ""
echo "====== Installing and Configuring Display and Touch Screen Drivers ======"
echo ""

if [ "$DISPLAY_TYPE" = "dsi" ]; then
  echo "Configuring for a native DSI touchscreen on Raspberry Pi OS Lite x64 Trixie."
  echo "No third-party display driver installation is required."

  apt install -y libinput-tools
  rm -f "$CALIBRATION_FILE"

  if ! grep -Eq '^display_auto_detect=1$' "$BOOT_CONFIG_FILE"; then
    ensure_config_line "$BOOT_CONFIG_FILE" 'display_auto_detect=1'
  fi

  if ! grep -Eq '^dtoverlay=vc4-kms-v3d$' "$BOOT_CONFIG_FILE"; then
    ensure_config_line "$BOOT_CONFIG_FILE" 'dtoverlay=vc4-kms-v3d'
  fi

  echo "DSI display path configured. The panel should be detected natively after reboot."
else
  echo "Configuring legacy SPI display support."
  cd "/home/$USERNAME"
  if [ ! -d "$LCD_SHOW_DIR/.git" ]; then
    git clone https://github.com/goodtft/LCD-show.git "$LCD_SHOW_DIR"
  fi

  chmod -R 755 "$LCD_SHOW_DIR"
  cd "$LCD_SHOW_DIR"
  sed -i -e 's/sudo reboot//' LCD35-show
  ./LCD35-show

  cd "/home/$USERNAME"
  cp "$LCD_SHOW_DIR/xinput-calibrator_0.7.5-1_armhf.deb" "/home/$USERNAME"
  apt install -y libc6 libgcc1 libstdc++6 libx11-6 libxext6 libxi6
  dpkg -i -B xinput-calibrator_0.7.5-1_armhf.deb

  echo 'Section "InputClass"' > "$CALIBRATION_FILE"
  echo '        Identifier "calibration"' >> "$CALIBRATION_FILE"
  echo '        MatchProduct "ADS7846 Touchscreen"' >> "$CALIBRATION_FILE"
  echo '        Option "Calibration" "2715 2684 2979 2964"' >> "$CALIBRATION_FILE"
  echo '        Option "SwapAxes" "0"' >> "$CALIBRATION_FILE"
  echo 'EndSection' >> "$CALIBRATION_FILE"

  sed -i -e 's/dtoverlay=tft35a:rotate=90/dtoverlay=tft35a:rotate=90,speed=24000000,fps=60/' "$BOOT_CONFIG_FILE"
fi

echo ""
echo "  ---- Display and touch screen drivers installed and configured. ----"
echo ""
echo "====== Installing Thermostat Application ======"
echo ""

cd "/home/$USERNAME"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone https://github.com/EthyMoney/AirConControl-Electron-MINI.git "$APP_DIR"
fi

cd "$APP_DIR"
/usr/local/bin/npm install
chown -R "$USERNAME:$USERNAME" "$APP_DIR"

echo ""
echo "  ---- Thermostat application installed. ----"
echo ""

read -p "All done! Would you like to reboot now? (You'll need to before this all works anyways) [Y/n] " -n 1 -r
echo ""
REPLY=${REPLY:-Y}

if [[ $REPLY =~ ^[Yy]$ ]]; then
  reboot
fi
