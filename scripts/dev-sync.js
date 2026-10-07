#!/usr/bin/env node
'use strict';

// scripts/dev-sync.js
//
// Copies shared source-of-truth files into an extension target folder so a
// browser can load the folder directly. Cross-platform port of dev-sync.ps1.
//
// Why: browsers require every file a manifest references to live at or below
// the manifest's folder. Shared src/lib/*.js, target adapters, and privacy
// policies live at the repo root as the single source of truth. This script
// mirrors them into extensions/<target>/ at build/dev time. The mirrored
// copies are git-ignored via .gitignore.
//
// Usage:
//   npm run sync                          # syncs the github target (default)
//   npm run sync -- --target github
//   npm run sync -- --target ado
//
// Exit codes: 0 on success, non-zero on failure.

const fs = require('node:fs');
const path = require('node:path');

const TARGETS = ['github', 'ado'];

function fail(message) {
  console.error(`[dev-sync] ${message}`);
  process.exit(1);
}

function parseTarget(argv) {
  const i = argv.indexOf('--target');
  if (i === -1) return 'github';
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`--target requires a value (${TARGETS.join('|')})`);
  return value;
}

function sync(target, root) {
  if (!TARGETS.includes(target)) fail(`--target must be one of ${TARGETS.join('|')}`);

  const targetDir = path.join(root, 'extensions', target);
  if (!fs.existsSync(targetDir)) fail(`Target folder does not exist: ${targetDir}`);

  // src/lib mirror
  const srcLib = path.join(root, 'src', 'lib');
  const dstLib = path.join(targetDir, 'src', 'lib');
  if (!fs.existsSync(srcLib)) fail(`Source folder does not exist: ${srcLib}`);

  fs.rmSync(dstLib, { recursive: true, force: true });
  fs.mkdirSync(dstLib, { recursive: true });

  const libFiles = fs.readdirSync(srcLib, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);
  for (const name of libFiles) {
    fs.cpSync(path.join(srcLib, name), path.join(dstLib, name));
  }
  console.log(`[dev-sync] ${target} : ${libFiles.length} src/lib file${libFiles.length === 1 ? '' : 's'} copied -> ${path.relative(root, dstLib)}`);

  // src/adapters mirror (only the current target's adapter, if it exists)
  const srcAdapter = path.join(root, 'src', 'adapters', `${target}.js`);
  if (fs.existsSync(srcAdapter)) {
    const dstAdapters = path.join(targetDir, 'src', 'adapters');
    fs.rmSync(dstAdapters, { recursive: true, force: true });
    fs.mkdirSync(dstAdapters, { recursive: true });
    const dstAdapter = path.join(dstAdapters, `${target}.js`);
    fs.cpSync(srcAdapter, dstAdapter);
    console.log(`[dev-sync] ${target} : src/adapters/${target}.js copied -> ${path.relative(root, dstAdapter)}`);
  }

  // Target privacy mirror. GitHub keeps the historical PRIVACY.md source;
  // ADO has a separate policy because its hosts, stored keys, and endpoint
  // behavior differ materially. Both ship as top-level PRIVACY.md.
  const privacyName = target === 'ado' ? 'PRIVACY_ADO.md' : 'PRIVACY.md';
  const srcPrivacy = path.join(root, privacyName);
  if (fs.existsSync(srcPrivacy)) {
    fs.cpSync(srcPrivacy, path.join(targetDir, 'PRIVACY.md'));
    console.log(`[dev-sync] ${target} : ${privacyName} copied -> PRIVACY.md`);
  } else {
    console.warn(`[dev-sync] WARNING: ${privacyName} not found at repo root - extension will ship without PRIVACY.md`);
  }
}

if (require.main === module) {
  sync(parseTarget(process.argv.slice(2)), path.join(__dirname, '..'));
}

module.exports = { TARGETS, sync };
