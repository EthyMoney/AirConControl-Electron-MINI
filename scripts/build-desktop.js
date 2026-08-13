#!/usr/bin/env node
'use strict';

// Builds the windowed Windows desktop variant.
//
// electron-builder extracts Electron into "<output>/win-unpacked.tmp" and then renames
// that directory into place. On Windows the rename fails with EPERM whenever another
// process holds a handle inside the tree, and this repo lives under a Nextcloud sync
// folder, so the sync client (and Defender) are still walking the tens of thousands of
// freshly extracted files when the rename runs. Staging the build outside the watched
// tree sidesteps that entirely; only the finished installer is copied back next to the
// project, which is a plain file write and safe to sync.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const stagingDir = path.join(os.tmpdir(), 'AirConControl-build', 'dist-desktop');
const outputDir = path.join(projectDir, 'dist-desktop');
const builderCli = require.resolve('electron-builder/cli.js');

// The unpacked application tree is hundreds of megabytes of intermediate output, so it
// stays in staging; only distributable files follow the build home.
const ARTIFACT_PATTERN = /\.(exe|blockmap|msi|appx|zip|yml)$/i;

function removeStaleTempDirs(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.tmp')) {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }
}

function copyArtifacts(startedAt) {
  if (!fs.existsSync(stagingDir)) {
    return [];
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const copied = [];
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (!entry.isFile() || !ARTIFACT_PATTERN.test(entry.name)) {
      continue;
    }
    const source = path.join(stagingDir, entry.name);
    // Staging is reused across runs, so an installer from an earlier build sticks
    // around. Only artifacts this run wrote should be published.
    if (fs.statSync(source).mtimeMs < startedAt) {
      continue;
    }
    fs.copyFileSync(source, path.join(outputDir, entry.name));
    copied.push(entry.name);
  }
  return copied;
}

// A crashed run leaves the half-extracted .tmp directory behind in either location.
removeStaleTempDirs(outputDir);
removeStaleTempDirs(stagingDir);
fs.mkdirSync(stagingDir, { recursive: true });

const builderArgs = [
  builderCli,
  '--win',
  ...process.argv.slice(2),
  '--config.extraMetadata.airconDesktopMode=true',
  `--config.directories.output=${stagingDir}`
];

console.log(`staging build in ${stagingDir}`);

const startedAt = Date.now();
const child = spawn(process.execPath, builderArgs, { cwd: projectDir, stdio: 'inherit' });

child.on('error', (error) => {
  console.error(`failed to start electron-builder: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  const copied = copyArtifacts(startedAt);
  if (copied.length === 0) {
    console.log(`build complete, output left in ${stagingDir}`);
  } else {
    console.log(`copied to ${outputDir}: ${copied.join(', ')}`);
  }
});
