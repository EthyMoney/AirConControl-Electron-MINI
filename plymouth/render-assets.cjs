#!/usr/bin/env electron

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, nativeImage } = require('electron');

const assetsDirectory = path.join(__dirname, 'assets');
const themeDirectory = path.join(__dirname, 'aircon-control');
const sourcePath = path.join(assetsDirectory, 'background-source.png');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createDotPng(layers) {
  const size = 18;
  const samplesPerAxis = 4;
  const sampleCount = samplesPerAxis * samplesPerAxis;
  const raw = Buffer.alloc((size * 4 + 1) * size);

  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0;

    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let opaqueSamples = 0;

      for (let sampleY = 0; sampleY < samplesPerAxis; sampleY += 1) {
        for (let sampleX = 0; sampleX < samplesPerAxis; sampleX += 1) {
          const pointX = x + (sampleX + 0.5) / samplesPerAxis;
          const pointY = y + (sampleY + 0.5) / samplesPerAxis;
          const distance = Math.hypot(pointX - 9, pointY - 9);
          const layer = layers.find((candidate) => distance <= candidate.radius);

          if (layer) {
            red += layer.color[0];
            green += layer.color[1];
            blue += layer.color[2];
            opaqueSamples += 1;
          }
        }
      }

      const pixelOffset = rowOffset + 1 + x * 4;
      if (opaqueSamples > 0) {
        raw[pixelOffset] = Math.round(red / opaqueSamples);
        raw[pixelOffset + 1] = Math.round(green / opaqueSamples);
        raw[pixelOffset + 2] = Math.round(blue / opaqueSamples);
        raw[pixelOffset + 3] = Math.round(255 * opaqueSamples / sampleCount);
      }
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function writeDot(name, layers) {
  fs.writeFileSync(path.join(themeDirectory, name), createDotPng(layers));
}

app.whenReady().then(() => {
  fs.mkdirSync(themeDirectory, { recursive: true });

  const source = nativeImage.createFromPath(sourcePath);
  if (source.isEmpty()) {
    throw new Error(`Could not load ${sourcePath}`);
  }

  const background = source.resize({
    width: 800,
    height: 480,
    quality: 'best'
  });
  fs.writeFileSync(path.join(themeDirectory, 'background.png'), background.toPNG());

  writeDot('dot-bright.png', [
    { radius: 4, color: [215, 239, 255] },
    { radius: 6, color: [102, 184, 255] }
  ]);
  writeDot('dot-dim.png', [
    { radius: 5, color: [49, 93, 128] }
  ]);

  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
