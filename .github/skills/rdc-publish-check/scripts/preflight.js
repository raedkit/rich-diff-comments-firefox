#!/usr/bin/env node
'use strict';

// Pre-publish audit for either separate Markdown PR Comments target.
// Cross-platform port of preflight.ps1 (plus a Firefox `web-ext lint` step).
//
// Run from anywhere; the repository root is located relative to this script.
//
// Usage:
//   npm run preflight                                          # github (default)
//   npm run preflight -- --target ado
//   npm run preflight -- --target ado --verify-zip rdc-ado-1.4.0.zip
//
// Exits 0 if all checks pass, non-zero otherwise.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { TARGETS, sync } = require(path.join(ROOT, 'scripts', 'dev-sync.js'));

// Dev-only paths that must never ship in a package.
const FORBIDDEN_PREFIXES = [
  'tests/', 'docs/', 'test_md_files/', 'design/', 'node_modules/',
  'package.json', 'package-lock.json', 'playwright.config.js',
  'test-results/', 'playwright-report/', '.git/', 'local-only/',
  '_local_only/', '.github/'
];

const issues = [];
const warnings = [];
const pass = (msg) => console.log(`  [OK]   ${msg}`);
const fail = (msg) => { console.log(`  [FAIL] ${msg}`); issues.push(msg); };
const warn = (msg) => { console.log(`  [WARN] ${msg}`); warnings.push(msg); };
const section = (title) => console.log(`\n== ${title} ==`);

function die(message) {
  console.error(`[preflight] ${message}`);
  process.exit(1);
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) die(`${name} requires a value`);
  return value;
}

function readJson(file) {
  // Strip a UTF-8 BOM if present; JSON.parse rejects it.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// ── Minimal zip reader (central directory + stored/deflate entries) ──────
// Stdlib only: no `unzip` binary (absent on Windows) and no extra dependency.
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file (end of central directory not found)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    // Normalise separators: some Windows archivers store backslashes.
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`zip entry not found: ${name}`);
    const o = e.localOffset;
    if (buf.readUInt32LE(o) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    const data = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return data;
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${e.method} for ${name}`);
  }

  return { names: [...entries.keys()], read };
}

function verifyZip(zipPath, manifest, target) {
  section(`Verify zip: ${zipPath}`);
  if (!fs.existsSync(zipPath)) { fail(`zip not found: ${zipPath}`); return; }

  let zip;
  try { zip = readZip(zipPath); } catch (err) { fail(`cannot read zip: ${err.message}`); return; }
  const names = zip.names;
  const has = (n) => names.includes(n);

  let zipManifest = null;
  if (!has('manifest.json')) {
    fail('manifest.json not at zip top level (Chrome rejects nested manifests)');
  } else {
    pass('manifest.json is at zip top level');
    zipManifest = JSON.parse(zip.read('manifest.json').toString('utf8').replace(/^﻿/, ''));

    if (zipManifest.name === manifest.name && zipManifest.version === manifest.version) {
      pass(`packaged manifest is ${manifest.name} v${manifest.version}`);
    } else {
      fail(`packaged manifest identity differs from extensions/${target}/manifest.json`);
    }

    const sourceHosts = (manifest.host_permissions || []).join('\n');
    const zipHosts = (zipManifest.host_permissions || []).join('\n');
    if (sourceHosts === zipHosts) pass(`packaged host permissions match the ${target} target`);
    else fail(`packaged host permissions do not match the ${target} target`);
  }

  if (zipManifest) {
    let missing = false;
    for (const cs of zipManifest.content_scripts || []) {
      for (const asset of [...(cs.js || []), ...(cs.css || [])]) {
        if (!has(asset.replace(/\\/g, '/'))) {
          fail(`content_scripts entry missing from zip: ${asset}`);
          missing = true;
        }
      }
    }
    if (!missing) pass('all content_scripts entries are in the zip');

    let iconsMissing = false;
    for (const [size, icon] of Object.entries(zipManifest.icons || {})) {
      if (!has(icon.replace(/\\/g, '/'))) {
        fail(`declared ${size} px icon missing from zip: ${icon}`);
        iconsMissing = true;
      }
    }
    if (!iconsMissing) pass('all declared icons are in the zip');
  }

  if (has('PRIVACY.md')) pass('target privacy policy is in the zip');
  else fail('PRIVACY.md missing from zip');

  const before = issues.length;
  for (const prefix of FORBIDDEN_PREFIXES) {
    const hits = names.filter((n) => n.startsWith(prefix));
    if (hits.length) {
      fail(`dev-only path leaked into zip: ${prefix} (found ${hits.length} ${hits.length === 1 ? 'entry' : 'entries'})`);
    }
  }
  if (issues.length === before) pass('no dev-only paths leaked into zip');
}

function lintFirefox(extDir) {
  section('Firefox lint (web-ext)');
  const webExt = path.join(ROOT, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  if (!fs.existsSync(webExt)) { fail('web-ext is not installed - run `npm install`'); return; }

  const r = spawnSync(process.execPath, [webExt, 'lint', '--source-dir', extDir, '--output', 'json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  let report;
  try { report = JSON.parse(r.stdout); } catch (_) { report = null; }
  if (!report) {
    fail(`web-ext lint produced no readable report (exit ${r.status}): ${(r.stderr || '').trim().split('\n')[0]}`);
    return;
  }
  for (const e of report.errors) fail(`lint ${e.code}: ${e.message}${e.file ? ` (${e.file})` : ''}`);
  if (report.summary.errors === 0) {
    pass(`web-ext lint: 0 errors, ${report.summary.warnings} warning(s), ${report.summary.notices} notice(s)`);
  }
  // Warnings (e.g. UNSAFE_VAR_ASSIGNMENT from innerHTML) are accepted; only counted.
}

function main(argv) {
  const target = argValue(argv, '--target') ?? 'github';
  if (!TARGETS.includes(target)) die(`--target must be one of ${TARGETS.join('|')}`);
  const zipArg = argValue(argv, '--verify-zip');

  const extPrefix = path.join('extensions', target);
  const extDir = path.join(ROOT, extPrefix);
  if (!fs.existsSync(extDir)) die(`Target folder does not exist: ${extDir}`);

  // Ensure the shared src/lib mirror and PRIVACY.md are up to date so the
  // path checks below find them.
  const log = console.log;
  console.log = () => {};
  try { sync(target, ROOT); } finally { console.log = log; }

  section('Manifest');
  const manifestPath = path.join(extDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { fail(`${path.join(extPrefix, 'manifest.json')} not found`); return finish(target); }

  const manifest = readJson(manifestPath);
  const version = manifest.version;
  pass(`version: ${version}`);
  pass(`name: ${manifest.name}`);
  if (!manifest.description) fail('manifest.description is empty');
  if (!manifest.icons || !manifest.icons['128']) {
    warn('manifest.icons.128 not declared - a declared 128px icon is recommended for the in-browser extensions list');
  }

  // --verify-zip short-circuits the rest of the checks.
  if (zipArg) {
    verifyZip(path.resolve(process.cwd(), zipArg), manifest, target);
    return finish(target, true);
  }

  section('Required files');
  for (const r of ['manifest.json', 'content.js', 'styles.css', 'PRIVACY.md']) {
    const p = path.join(extPrefix, r);
    if (fs.existsSync(path.join(ROOT, p))) pass(`${p} exists`); else fail(`${p} missing`);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const asset of [...(cs.js || []), ...(cs.css || [])]) {
      const p = path.join(extPrefix, asset);
      if (fs.existsSync(path.join(ROOT, p))) pass(`content_scripts entry: ${p}`); else fail(`content_scripts entry missing: ${p}`);
    }
  }
  for (const [size, icon] of Object.entries(manifest.icons || {})) {
    const p = path.join(extPrefix, icon);
    if (fs.existsSync(path.join(ROOT, p))) pass(`icon ${size} : ${p}`); else fail(`icon ${size} missing: ${p}`);
  }

  lintFirefox(extDir);

  section('Tests');
  const testsDir = path.join(ROOT, 'tests');
  const testFiles = fs.existsSync(testsDir)
    ? fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('tests', f))
    : [];
  if (testFiles.length === 0) {
    warn('no tests/*.test.js files found');
  } else if (!fs.existsSync(path.join(ROOT, 'node_modules', 'jsdom'))) {
    fail('node_modules/jsdom missing - run `npm install`, then re-run preflight');
  } else {
    const r = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) {
      // Node 22 emits "# pass N"; Node 24's spec reporter emits "ℹ pass N".
      const m = /(?:^|\n)\D*\bpass\s+(\d+)/.exec(r.stdout || '');
      pass(`test suite passed (${m ? `${m[1]} tests` : 'all tests'})`);
    } else {
      fail(`test suite failed (exit ${r.status}) - run 'npm test' to see details`);
    }
  }

  section('Version sanity');
  const changelogName = target === 'ado' ? 'CHANGELOG_ADO.md' : 'CHANGELOG.md';
  const changelogPath = path.join(ROOT, changelogName);
  if (fs.existsSync(changelogPath)) {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`##\\s*\\[${escaped}\\]`).test(changelog)) pass(`${changelogName} has an entry for ${version}`);
    else warn(`${changelogName} has no entry for ${version} - add a '## [${version}] - <date>' section before publishing`);
  } else {
    warn(`no ${changelogName} at repo root`);
  }

  finish(target);
}

function finish(target, zipMode = false) {
  section('Summary');
  if (issues.length) {
    console.log(`${issues.length} FAILURE(s)${zipMode ? '' : ' - fix before packaging'}:`);
    for (const i of issues) console.log(`  - ${i}`);
    process.exit(1);
  }
  if (zipMode) {
    console.log('zip looks good');
  } else {
    console.log(warnings.length
      ? `READY TO PACKAGE (with ${warnings.length} warning(s) - review above)`
      : 'READY TO PACKAGE');
    console.log(`Next step: npm run package -- --target ${target}`);
  }
  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
