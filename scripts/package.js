#!/usr/bin/env node
'use strict';

// scripts/package.js
//
// Builds a publish-ready zip for a target: rdc-<ver>.zip (github) or
// rdc-<target>-<ver>.zip. The same zip is accepted by the Chrome Web Store,
// Edge Add-ons, and addons.mozilla.org. Cross-platform port of package.ps1.
//
// Runs dev-sync first so the target folder has the latest shared src/lib/*.js,
// target adapter, and privacy policy, then zips extensions/<target>/ with
// `web-ext build` so the zip contents are exactly what the browser sees when
// the folder is dev-loaded (manifest.json at the zip root).
//
// Usage:
//   npm run package                                  # github (default)
//   npm run package -- --target ado
//   npm run package -- --target ado --output out/ado.zip
//
// See docs/PUBLISHING.md for the surrounding workflow.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TARGETS, sync } = require('./dev-sync.js');

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function main(argv) {
  const root = path.join(__dirname, '..');
  const target = argValue(argv, '--target') ?? 'github';
  if (!TARGETS.includes(target)) fail(`--target must be one of ${TARGETS.join('|')}`);

  const targetDir = path.join(root, 'extensions', target);
  if (!fs.existsSync(targetDir)) fail(`Target folder does not exist: ${targetDir}`);

  // Refresh mirrored files (src/lib, adapter, PRIVACY.md) before packaging.
  sync(target, root);

  const { version } = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8'));

  // Preserve the established GitHub artifact name. Qualify every additional
  // target so same-version first releases cannot overwrite the GitHub zip.
  const stem = target === 'github' ? 'rdc' : `rdc-${target}`;
  const defaultName = `${stem}-${version}.zip`;
  const output = argValue(argv, '--output');
  // Relative --output paths resolve against the repo root.
  const outputPath = output ? path.resolve(root, output) : path.join(root, defaultName);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const webExt = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  if (!fs.existsSync(webExt)) fail('web-ext is not installed - run `npm install` first');

  const result = spawnSync(process.execPath, [
    webExt, 'build',
    '--source-dir', targetDir,
    '--artifacts-dir', path.dirname(outputPath),
    '--filename', path.basename(outputPath),
    '--overwrite-dest'
  ], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail(`web-ext build failed (exit ${result.status})`);

  const kb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`[package] Built ${path.relative(root, outputPath)} (${kb} KB) from extensions/${target}`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
