# Shop Climate Control Plymouth theme

This directory contains the complete, reusable Plymouth boot theme for the
Raspberry Pi thermostat. It is designed for the native 800×480 DSI display on
a Raspberry Pi 3 and scales with a centered crop on other framebuffer sizes.

## Design

The splash follows the thermostat application's dark cooling palette:

- deep charcoal/navy background
- centered ice-blue snowflake and airflow arcs
- `SHOP CLIMATE CONTROL` and `STARTING THERMOSTAT` labels
- three softly pulsing loading dots

The animation is implemented by Plymouth's script plugin. It changes opacity
on three 18×18 sprites instead of decoding video or rendering particles, which
keeps early-boot CPU and memory use low.

The source background was created with OpenAI's built-in image generator using
this production brief:

> Minimal cooling-themed Plymouth background for an 800×480 Raspberry Pi
> thermostat touchscreen. Use a seamless deep-charcoal backdrop with a subtle
> cool-blue central glow, one centered geometric six-arm snowflake, and
> understated airflow arcs. Keep generous negative space below for separately
> rendered loading text and progress dots. Use `#222222`, `#111820`, and
> `#66b8ff`. No text, letters, numbers, logos, watermark, border, particles,
> photographic objects, excessive bloom, or tiny detail.

## Files

| Path | Purpose |
| --- | --- |
| `assets/background-source.png` | Full-resolution generated source artwork |
| `aircon-control/background.png` | Deployment-ready 800×480 splash image |
| `aircon-control/dot-*.png` | Bright and dim animation sprites |
| `aircon-control/aircon-control.script` | Plymouth layout, text, animation, and message handling |
| `aircon-control/aircon-control.plymouth` | Plymouth theme manifest |
| `render-assets.cjs` | Rebuilds deployment PNGs from the source artwork |
| `install-theme.sh` | Installs and configures the theme on a Raspberry Pi |

## Install on another thermostat

Start from Raspberry Pi OS with this repository cloned and run:

```bash
cd AirConControl-Electron-MINI
sudo ./plymouth/install-theme.sh
sudo reboot
```

The installer:

1. copies the theme to `/usr/share/plymouth/themes/aircon-control`;
2. selects `aircon-control` as the default Plymouth theme;
3. adds `quiet splash plymouth.ignore-serial-consoles`, kernel-logo suppression,
   and cursor suppression to the boot command line when missing;
4. sets `disable_splash=1` to disable the Raspberry Pi firmware rainbow screen;
5. forces the native DSI display chain into the initramfs because dependency
   discovery does not include the `tc358762` bridge early enough on this panel;
6. rebuilds the initramfs.

The script defaults to the DSI display. For the legacy SPI installer path, use:

```bash
sudo env DISPLAY_TYPE=spi ./plymouth/install-theme.sh
```

The project-level `installer.sh` performs the same setup automatically during a
full kiosk installation.

## Rebuild the images

After changing `background-source.png` or the dot definitions in
`render-assets.cjs`, install the project dependencies and run:

```bash
npm install
npm run render:plymouth
```

This resizes the generated source to exactly 800×480 and writes deterministic,
antialiased dot PNGs without adding an image-processing dependency to the app.

## Verify an installed device

Check the selected theme and required boot settings:

```bash
plymouth-set-default-theme
grep '^disable_splash=' /boot/firmware/config.txt
cat /boot/firmware/cmdline.txt
grep -E '^(i2c_bcm2835|rpi_panel_attiny_regulator|tc358762|vc4)$' \
  /etc/initramfs-tools/modules
```

Confirm the active initramfs contains both the theme and DSI bridge:

```bash
lsinitramfs "/boot/initrd.img-$(uname -r)" | \
  grep -E 'aircon-control|tc358762'
```

If the theme appears only during shutdown, rebuild the initramfs after ensuring
the four DSI modules above are listed. That symptom means the live root
filesystem can render the theme but the early boot image cannot initialize the
DSI DRM device.
