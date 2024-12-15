#!/bin/bash

# This will set up a new fresh pi running pi os lite for booting into minimal display manager and running the app
# This will also install and configure the SPI display and touch screen drivers

# With x64 Pi OS Bookworm Lite: Tested working on Pi 4, but on Pi 3 the openbox session does not start and instead we get stuck at a logged in terminal.
# As a workaround for the Pi 3, you can use the 32-bit Pi OS Bullseye (legacy) Lite, which works fine with this script. Maybe 64-bit Bullseye Lite works too, but I haven't tested it. I tested 32-bit Bullseye Lite on a Pi 3 and it worked fine.

USERNAME="logan"

# Check for root privileges
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root" 
   exit 1
fi

echo ""
echo ""
echo "======================= Minimal Display Manager With Single Application Kiosk Installer For Raspberry Pi ======================="
echo ""
echo ""

echo "====== Running Pre-Installation Checks ======"
echo ""

# Verify that the internet is reachable
if ! ping -q -c 1 -W 1 google.com >/dev/null; then
    echo "The internet is not reachable. Please check your network connection and try again."
    exit 1
fi

# Verify that the configured username exists
if ! id -u $USERNAME &>/dev/null; then
    echo "The configured username '$USERNAME' does not exist. Either change this user to match yours, or create the user and try again. Try running from `sudo su` as root as well."
    echo ""
    exit 1
fi

echo "Pre-installation checks passed. Proceeding with installation..."
echo ""

echo ""
echo "====== Performing System Update ======"
echo ""

apt update && apt upgrade -y

echo ""
echo "OS updated."
echo ""

echo ""
echo "====== Installing APT Packages ======"
echo ""

#! YOU WILL BE ASKED ABOUT PICKING A DISPLAY MANAGER DUE TO HAVEING BOTH INSTALLED, SELECT NODM WHEN PROMPTED!!!!

apt install vnstat neofetch git nodm lightdm compton xserver-xorg xserver-xorg-input-all xinit x11-xserver-utils xserver-xorg-core xserver-xorg-video-all openbox feh plymouth-themes plymouth-label npm wavemon -y

echo ""
echo "====== Installing Updated Node.js and NPM + Global Packages ======"
echo ""

npm i n -g
n lts
hash -r
npm i -g npm
npm i -g npm-check-updates eslint ts-node typescript pm2
hash -r

echo ""
echo "====== Configuring Minimal Display Manager ======"
echo ""

# Configure nodm file
sed -i -e "s/NODM_ENABLED=false/NODM_ENABLED=true/" -e "s/NODM_USER=root/NODM_USER=$USERNAME/" \
  /etc/default/nodm

echo ""
echo "Minimal display manager configured."
echo ""

# Create the autostart file at /home/$USERNAME/.config/openbox/autostart
mkdir -p /home/$USERNAME/.config/openbox
cat << 'EOF' > /home/$USERNAME/.config/openbox/autostart

# Disable screen saver and power management
xset s off
xset -dpms
xset s noblank

# Comption for display performance and vsync
compton -b &

# Environment variables for Node.js and npm
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

# Start the application
while true; do
  echo "Starting application..."
  cd /home/logan/AirConControl-Electron-MINI
  npm start
  sleep 5
done &
EOF

# Ensure the script is executable
chmod +x /home/$USERNAME/.config/openbox/autostart

# Create xsession file to launch openbox (required for nodm on ubuntu, this isn't needed on Raspberry Pi OS but doesn't hurt to do anyways)
echo "#!/bin/bash" > /home/$USERNAME/.xsession
echo "xset s off" >> /home/$USERNAME/.xsession
echo "xset -dpms" >> /home/$USERNAME/.xsession
echo "xset s noblank" >> /home/$USERNAME/.xsession
echo "exec openbox-session" >> /home/$USERNAME/.xsession

# Make the .xsession file executable
chmod +x /home/$USERNAME/.xsession

# Change the owner of the .xsession file to the user
chown $USERNAME:$USERNAME /home/$USERNAME/.xsession

echo ""
echo "Openbox autostart and display manager configured."
echo ""

echo ""
echo "====== Configuring LightDM Autologin ======"
echo ""

# Configure LightDM autologin using nodm as the display manager (same as using raspi-config and selecting "Desktop Autologin")
# This fails silently on a non-Raspberry Pi system, this will just skip and continue when it fails, all good because nodm was configured above
sed -i 's/#autologin-user=/autologin-user=$USERNAME/' /etc/lightdm/lightdm.conf

echo ""
echo "LightDM autologin configured."
echo ""

echo ""
echo "====== Processing Pi Configuration Special Triggers ======"
echo ""

raspi-config nonint do_boot_behaviour B4

# Config adjustments for display performance using compton
echo -e "vsync = true;\nbackend = \"glx\";\nfading = false;\nshadow-exclude = [ \"name = 'cursor'\" ];" >/home/$USERNAME/.config/compton.conf

update-initramfs -u

# Ensure the user owns their config files
chown -R $USERNAME:$USERNAME /home/$USERNAME/.config

echo ""
echo "Configuration triggers complete."
echo ""

echo ""
echo "====== Installing and Configuring Display and Touch Screen Drivers ======"
echo ""

# Aight, now let's install and configure the display and touch capabilities, assuming a 3.5" SPI display, adjust as needed for others (LCD-Show has multiple versions of the setup scripts)
cd /home/$USERNAME

git clone https://github.com/goodtft/LCD-show.git
chmod -R 755 LCD-show
cd LCD-show

# Remove the "sudo reboot" from the end of the LCD35-show file to prevent the pi from rebooting after this part
sed -i -e "s/sudo reboot//" LCD35-show

./LCD35-show

cd /home/$USERNAME

# if needed, rotate:
# cd LCD-show/
# sudo ./rotate.sh 90

# Install the calibration tool
cp LCD-show/xinput-calibrator_0.7.5-1_armhf.deb /home/$USERNAME

# To run the calibration tool:
# DISPLAY=:0.0 xinput_calibrator

# Install the dependencies for the calibration tool
apt install libc6 libgcc1 libstdc++6 libx11-6 libxext6 libxi6 -y

dpkg -i -B xinput-calibrator_0.7.5-1_armhf.deb

# Create calibration file
# This preset should work for the 3.5" display out of the box, even pre-calibrated!
# You may need to run the calibration tool again for yours, the calibration tool will output what to put in this file)
echo 'Section "InputClass"
        Identifier "calibration"
        MatchProduct "ADS7846 Touchscreen"
        Option "Calibration" "2715 2684 2979 2964"
        Option "SwapAxes" "0"
EndSection' | tee /etc/X11/xorg.conf.d/99-calibration.conf > /dev/null

# Now set a higher speed for the SPI connection to the display for improved performance and refresh rate
# Replace dtoverlay=tft35a:rotate=90 with dtoverlay=tft35a:rotate=90,speed=24000000,fps=60 at /boot/config.txt
sed -i -e "s/dtoverlay=tft35a:rotate=90/dtoverlay=tft35a:rotate=90,speed=24000000,fps=60/" /boot/config.txt
# Note, the above line is what you need to change if you wish to rotate the display orientation or attempt to change the speed or fps on a different display

echo ""
echo "  ---- Display and touch screen drivers installed and configured. ----"
echo ""

echo ""
echo "====== Installing Thermostat Application ======"
echo ""

# Clone the thermostat application
cd /home/$USERNAME
git clone https://github.com/EthyMoney/AirConControl-Electron-MINI.git

# Install the application dependencies
cd AirConControl-Electron-MINI
npm install

# Set username as the owner of the application files
chown -R $USERNAME:$USERNAME /home/$USERNAME/AirConControl-Electron-MINI

echo ""
echo "  ---- Thermostat application installed. ----"
echo ""

# Now prompt the user to reboot with a default of yes
echo ""
echo ""
read -p "All done! Would you like to reboot now? (You'll need to before this all works anyways) [Y/n] " -n 1 -r
REPLY=${REPLY:-Y}

if [[ $REPLY =~ ^[Yy]$ ]]; then
  reboot
fi
# End of script

# For the record, the display setup stuff came from here:
# https://cdn.sparkfun.com/assets/4/c/2/0/8/User_Guide_For_3.5_inch_LCD.pdf

# And the display manager and auto-start stuff came from here:
# https://raspberrypi.stackexchange.com/questions/57128/how-to-boot-into-own-python-script-gui-only/57560#57560
# Be sure to look at the footnote for raspbian lite, that's what I usually use
