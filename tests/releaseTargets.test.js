'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const packageScript = read('scripts', 'package.js');
const syncScript = read('scripts', 'dev-sync.js');
const preflightScript = read('.github', 'skills', 'rdc-publish-check', 'scripts', 'preflight.js');
const prepScript = read('.github', 'skills', 'rdc-publish-check', 'scripts', 'release-prep.ps1');
const releaseScript = read('.github', 'skills', 'rdc-publish-check', 'scripts', 'github-release.ps1');
const promoScript = read('design', 'promo-tiles', 'generate.ps1');

const githubManifest = JSON.parse(read('extensions', 'github', 'manifest.json'));
const adoManifest = JSON.parse(read('extensions', 'ado', 'manifest.json'));

test('Node scripts require an explicit supported target contract', () => {
  for (const [name, script] of [
    ['package.js', packageScript],
    ['preflight.js', preflightScript]
  ]) {
    assert.match(script, /require\(.*dev-sync\.js'?\)/, `${name} must reuse the dev-sync TARGETS list`);
    assert.match(script, /--target/, `${name} must take a --target argument`);
    assert.match(script, /argValue\([^)]*'--target'\) \?\? 'github'/, `${name} must preserve GitHub as the backward-compatible default`);
    assert.match(script, /TARGETS\.includes\(target\)/, `${name} must reject unsupported targets`);
  }
});

test('PowerShell release scripts require an explicit supported target contract', () => {
  for (const [name, script] of [
    ['release-prep.ps1', prepScript],
    ['github-release.ps1', releaseScript]
  ]) {
    assert.match(script, /\[ValidateSet\('github', 'ado'\)\]/, `${name} must support only github and ado targets`);
    assert.match(script, /\[string\]\$Target\s*=\s*'github'/, `${name} must preserve GitHub as the backward-compatible default`);
  }
  assert.match(promoScript, /\[ValidateSet\('github', 'ado'\)\]/);
  assert.match(promoScript, /\[string\]\$Target = 'github'/);
  assert.match(promoScript, /Join-Path \$PSScriptRoot 'ado'/);
  assert.match(promoScript, /design\\logo\\ado\\icon-1024\.png/);
});

test('dev-sync supports only github and ado, defaulting to github', () => {
  assert.match(syncScript, /TARGETS = \['github', 'ado'\]/);
  assert.match(syncScript, /if \(i === -1\) return 'github'/);
  const { TARGETS } = require('../scripts/dev-sync.js');
  assert.deepEqual(TARGETS, ['github', 'ado']);
});

test('ADO package and release folder names cannot collide with GitHub artifacts', () => {
  assert.match(packageScript, /target === 'github' \? 'rdc' : `rdc-\$\{target\}`/);
  assert.match(prepScript, /Join-Path \(Join-Path 'releases' \$Target\) \$version/);
  assert.match(prepScript, /\$artifactStem = if \(\$Target -eq 'github'\) \{ 'rdc' \} else \{ "rdc-\$Target" \}/);
  assert.match(releaseScript, /"releases\\\$Target\\\$version"/);
  assert.match(releaseScript, /\$artifactStem = if \(\$Target -eq 'github'\) \{ 'rdc' \} else \{ "rdc-\$Target" \}/);
});

test('ADO sync and audit use the ADO-specific privacy policy and changelog', () => {
  assert.match(syncScript, /target === 'ado' \? 'PRIVACY_ADO\.md' : 'PRIVACY\.md'/);
  assert.match(preflightScript, /target === 'ado' \? 'CHANGELOG_ADO\.md' : 'CHANGELOG\.md'/);
  assert.match(releaseScript, /if \(\$Target -eq 'ado'\) \{ 'CHANGELOG_ADO\.md' \} else \{ 'CHANGELOG\.md' \}/);
  assert.match(preflightScript, /packaged manifest identity differs from extensions\/\$\{target\}\/manifest\.json/);
  assert.match(preflightScript, /packaged host permissions match the \$\{target\} target/);
  assert.match(preflightScript, /all declared icons are in the zip/);
  assert.match(preflightScript, /target privacy policy is in the zip/);
  assert.match(preflightScript, /pass\\s\+\(\\d\+\)/);
  assert.match(preflightScript, /'all tests'/);
  assert.match(syncScript, /src', 'adapters', `\$\{target\}\.js`/);
});

test('ADO release uses a target-qualified tag and submission documents', () => {
  assert.match(releaseScript, /if \(\$Target -eq 'github'\) \{ "v\$version" \} else \{ "\$Target-v\$version" \}/);
  assert.match(releaseScript, /\$ErrorActionPreference = 'Continue'[\s\S]*?gh release view \$tag 2>&1[\s\S]*?\$releaseViewExit = \$LASTEXITCODE/);
  assert.match(releaseScript, /if \(\$releaseViewExit -eq 0\)/);
  assert.match(releaseScript, /\[System\.IO\.File\]::ReadAllText\(\$changelogPath, \[System\.Text\.Encoding\]::UTF8\)/);
  assert.match(releaseScript, /\[System\.IO\.File\]::WriteAllText\(\$notesPath, \$notes, \$utf8NoBom\)/);
  assert.match(prepScript, /CHROME_SUBMISSION\$templateSuffix\.md/);
  assert.match(prepScript, /EDGE_SUBMISSION\$templateSuffix\.md/);
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'skills', 'rdc-publish-check', 'templates', 'CHROME_SUBMISSION_ADO.md')), true);
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'skills', 'rdc-publish-check', 'templates', 'EDGE_SUBMISSION_ADO.md')), true);
});

test('release scripts preserve non-ASCII manifest names', () => {
  for (const [name, script] of [
    ['release-prep.ps1', prepScript],
    ['github-release.ps1', releaseScript]
  ]) {
    assert.match(
      script,
      /Get-Content \$manifestPath -Raw -Encoding UTF8 \| ConvertFrom-Json/,
      `${name} must decode manifest.json as UTF-8`
    );
  }
  for (const [name, script] of [
    ['package.js', packageScript],
    ['preflight.js', preflightScript]
  ]) {
    assert.match(script, /readFileSync\(.*'utf8'\)/, `${name} must decode files as UTF-8`);
  }
  assert.match(preflightScript, /toString\('utf8'\)/, 'preflight.js must decode the zipped manifest as UTF-8');
});

test('release-prep builds through the Node packager', () => {
  assert.match(prepScript, /node \(Join-Path \$root "scripts\\package\.js"\) --target \$Target/);
  assert.doesNotMatch(prepScript, /package\.ps1/);
});

test('PowerShell build scripts were replaced by Node ports', () => {
  for (const gone of [
    ['scripts', 'dev-sync.ps1'],
    ['scripts', 'package.ps1'],
    ['.github', 'skills', 'rdc-publish-check', 'scripts', 'preflight.ps1']
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, ...gone)), false, `${gone.join('/')} must stay removed`);
  }
});

test('preflight denylist blocks dev-only paths from the package', () => {
  for (const prefix of ['tests/', 'docs/', 'node_modules/', '.github/', 'design/', 'local-only/', '.git/', 'package.json']) {
    assert.ok(preflightScript.includes(`'${prefix}'`), `denylist must contain ${prefix}`);
  }
});

test('package.js zips through web-ext build with target-qualified names', () => {
  assert.match(packageScript, /'build'/);
  assert.match(packageScript, /'--filename'/);
  assert.match(packageScript, /'--overwrite-dest'/);
});

test('GitHub and ADO manifests remain separately scoped', () => {
  assert.deepEqual(githubManifest.host_permissions, ['https://github.com/*']);
  assert.deepEqual(adoManifest.host_permissions, [
    'https://dev.azure.com/*',
    'https://*.visualstudio.com/*'
  ]);
  assert.equal(githubManifest.version, '1.13.0');
  assert.equal(adoManifest.version, '1.5.0');
  assert.match(adoManifest.name, /Azure DevOps/);
  assert.doesNotMatch(githubManifest.name, /Azure DevOps/);

  for (const size of [16, 32, 48, 128]) {
    const png = fs.readFileSync(path.join(ROOT, 'extensions', 'ado', 'icons', `icon-${size}.png`));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), size, `ADO ${size}px icon width`);
    assert.equal(png.readUInt32BE(20), size, `ADO ${size}px icon height`);
  }
  for (const size of [300, 1024]) {
    const png = fs.readFileSync(path.join(ROOT, 'design', 'logo', 'ado', `icon-${size}.png`));
    assert.equal(png.readUInt32BE(16), size, `ADO ${size}px logo width`);
    assert.equal(png.readUInt32BE(20), size, `ADO ${size}px logo height`);
  }
  for (const [name, width, height] of [
    ['small-440x280.png', 440, 280],
    ['small-tile-880x560.png', 880, 560],
    ['marquee-1400x560.png', 1400, 560],
    ['large-tile-2800x1120.png', 2800, 1120]
  ]) {
    const png = fs.readFileSync(path.join(ROOT, 'design', 'promo-tiles', 'ado', name));
    assert.equal(png.readUInt32BE(16), width, `${name} width`);
    assert.equal(png.readUInt32BE(20), height, `${name} height`);
  }

  const iconSource = read('design', 'icon-v2', 'icon-ado.svg');
  assert.match(iconSource, /Fluent blue outer bubble\/frame \(#0078d4\)/);
  assert.match(iconSource, /White message interior/);
  assert.match(iconSource, /Fluent blue "M" and down arrow/);
});

test('manifests pin the Firefox (Gecko) identity and data-collection declaration', () => {
  for (const [manifest, id] of [
    [githubManifest, 'markdown-pr-github@raedkit-fork'],
    [adoManifest, 'markdown-pr-ado@raedkit-fork']
  ]) {
    const gecko = manifest.browser_specific_settings.gecko;
    assert.equal(gecko.id, id);
    assert.equal(gecko.strict_min_version, '140.0');
    assert.deepEqual(gecko.data_collection_permissions.required, ['none']);
    // Android honours data_collection_permissions only from 142.
    assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, '142.0');
  }
  // Runtime-affecting keys stay as they were.
  assert.equal(adoManifest.content_scripts[0].world, 'MAIN');
  assert.equal(adoManifest.content_scripts[0].run_at, 'document_end');
  assert.equal(githubManifest.permissions, undefined);
  assert.equal(adoManifest.permissions, undefined);
});

test('ADO store forms disclose the correct public privacy policy and current package', () => {
  for (const templateName of ['CHROME_SUBMISSION_ADO.md', 'EDGE_SUBMISSION_ADO.md']) {
    const template = read('.github', 'skills', 'rdc-publish-check', 'templates', templateName);
    assert.match(template, /rdc-ado-1\.5\.0\.zip/);
    assert.match(template, /PRIVACY_ADO\.md/);
    assert.match(template, /https:\/\/dev\.azure\.com\/\*/);
    assert.match(template, /https:\/\/\*\.visualstudio\.com\/\*/);
    assert.match(template, /not affiliated with, endorsed by, sponsored by, or otherwise connected to Microsoft Corporation/i);
  }
});

test('Firefox signing is an unlisted web-ext step and its output is git-ignored', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['sign:firefox'], 'web-ext sign --channel unlisted');
  assert.match(read('.gitignore'), /^web-ext-artifacts\/$/m);
});
