# Agent context: Markdown PR Comments for GitHub and Azure DevOps

Two browser-extension targets (Chromium and Firefox, from the same manifests) add inline review-comment UI to GitHub PR rich diff and Azure DevOps PR Preview. **Source of truth is here** (`c:\Local\local_repos\rich-diff-comments\`). A snapshot mirror lives at `content-understanding/tools/github-rich-diff-comments/` — **don't edit that copy**.

## Instructions

### CHANGELOG is user-facing — not engineering notes

Every entry in `CHANGELOG.md` or `CHANGELOG_ADO.md` (and the equivalent blocks in the matching store submission templates) must read like a feature announcement to someone who has never opened the source code.

- **Forbidden:** internal class / file / function names, CSS selectors, DOM-shape detail (`<th>` vs `<td>` cells), specific line numbers from a bug repro file, "we did X via Y" implementation talk, **dev infrastructure changes** (test suites, refactors, library extractions, build-system tweaks, devDependency bumps).
- **Required:** describe what the user sees, when they'd notice it, and why it's better. Use product names ("the threads sidebar", "the Outline tab"), not selectors.
- **When in doubt:** *"Would a non-developer Chrome extension user understand what changed for them?"* If no, it doesn't go in CHANGELOG.

**Full rules + examples:** [.github/skills/rdc-publish-check/SKILL.md → CHANGELOG / release-notes writing rules](.github/skills/rdc-publish-check/SKILL.md#changelog--release-notes-writing-rules).

### Where each kind of change belongs

| What | Where |
|---|---|
| User-visible feature or bug fix | GitHub: `CHANGELOG.md`; ADO: `CHANGELOG_ADO.md`; plus the matching target's store submission docs |
| Dev infrastructure (tests, refactors, lib extractions, devDeps) | Git commit message only — **NOT** CHANGELOG |
| Captured endpoint payloads, DOM quirks, "I thought X but actually Y" | GitHub: [docs/github/DEV_NOTES.md](docs/github/DEV_NOTES.md); ADO: [docs/ado/ADO_DEV_NOTES.md](docs/ado/ADO_DEV_NOTES.md) |
| Stable architecture decisions (why we forward-scan match, LEFT vs RIGHT side, edge-case strategy) | GitHub: [docs/github/APPROACH.md](docs/github/APPROACH.md); ADO history: [docs/ado/ADO_ADAPTER_PLAN.md](docs/ado/ADO_ADAPTER_PLAN.md) |
| Shared feature parity roadmap, both target statuses, priority (P0–P3) | [docs/FEATURES.md](docs/FEATURES.md) |
| Host-specific feature mechanics and constraints | GitHub: [docs/github/FEATURES.md](docs/github/FEATURES.md); ADO: [docs/ado/FEATURES.md](docs/ado/FEATURES.md) |

### Repo layout

The repository is a monorepo with per-target extension folders sharing a single source of truth for pure logic.

- **`src/lib/`** — DOM-agnostic pure helpers (source of truth). Shared across every extension target. Tests import from here.
- **`extensions/github/`** — the GitHub extension: `manifest.json`, `content.js`, `styles.css`, `icons/`, plus `src/lib/*.js` and `PRIVACY.md` mirrored in by `npm run sync -- --target github`. **Chrome / Edge load unpacked from this folder; Firefox loads it with `npx web-ext run --source-dir extensions/github`.**
- **`extensions/ado/`** — the Azure DevOps extension and adapter mirror. See [docs/ado/FEATURES.md](docs/ado/FEATURES.md) and [docs/ado/ADO_ADAPTER_PLAN.md](docs/ado/ADO_ADAPTER_PLAN.md).
- **`npm run sync -- --target github`** (`scripts/dev-sync.js`) — copies shared files from repo root into a target folder. Runs automatically before `npm run package` and `npm run preflight`. Re-run manually after editing anything under `src/lib/` if Chrome has the extension dev-loaded, then reload the extension.
- **`npm run package -- --target github|ado`** (`scripts/package.js`) — builds a publish-ready zip from `extensions/<target>/` with `web-ext build`. Default target is `github`.
- **`npm run sign:firefox -- --source-dir extensions/<target>`** — signs an unlisted Firefox `.xpi` into the git-ignored `web-ext-artifacts/`; needs `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` in the environment (never commit them).
- **`extensions/*/src/`** and **`extensions/*/PRIVACY.md`** are git-ignored — they're build output.

### Tests

- `npm test` — 410 Node:test unit/static tests (no browser). Run before every commit touching JS.
- `npm run test:e2e` / `npm run test:e2e:github` — 21 GitHub fixture tests in headless Chromium.
- `npm run test:e2e:ado` — 63 ADO Preview + mocked REST fixture tests in headless Chromium.
- `npm run test:e2e:all` — both browser targets, each in Chromium and Firefox (`npx playwright install chromium firefox` once).
- `npm run test:e2e:firefox` — Firefox project only.
- `npm run test:all` — Node tests plus both browser targets.
- Preflight (`npm run preflight -- --target github|ado`, i.e. `.github/skills/rdc-publish-check/scripts/preflight.js`) runs `npm test` and `web-ext lint` only — add `test:e2e` to your manual flow when DOM behavior changed.

### What ships vs. what stays local

The published zip is built by [scripts/package.js](scripts/package.js) (`--target github` by default) from `extensions/github/`. That folder contains:

- **Physical files** (moved here from repo root during the refactor): `manifest.json`, `content.js`, `styles.css`, `icons/`.
- **Mirrored files** (copied in by `scripts/dev-sync.js` from repo-root source-of-truth): `src/lib/*.js`, `PRIVACY.md`.

`package.js` runs dev-sync automatically before zipping, so the shipped bundle is always in sync with the source. Everything else (`node_modules/`, `package.json`, `tests/`, `docs/`, `playwright.config.js`, `.github/`, `local-only/`, the repo-root `src/`) is naturally excluded because it lives outside `extensions/github/`; preflight's `--verify-zip` mode also has a forbidden-paths denylist as a safety net. The extension ships **zero runtime npm dependencies** — `jsdom` and `@playwright/test` are dev-only.

### Skills

Under `.github/skills/`:
- **`rdc-feature-dev`** — the build-a-feature loop: identify → define the shared outcome and target statuses in FEATURES.md → record only necessary target differences → build → test → docs. Use when starting any new feature or bug fix.
- **`rdc-publish-check`** — release prep: bump version, update CHANGELOG, run preflight, build zip, publish to stores. Use for every release.

Each skill's `SKILL.md` has the detailed workflow. Consult them before improvising.

## Common mistakes to avoid

- **Putting dev-infra changes in CHANGELOG.** Test suites, refactors, performance work, devDep bumps don't belong there — they're invisible to users. They belong in commit messages.
- **Editing the mirror.** `content-understanding/tools/github-rich-diff-comments/` is a snapshot. All work goes here.
- **Hand-editing the published zip.** The zip is rebuilt from source by `release-prep.ps1` every release. Edits to the zip itself would be lost.
- **Adding to `[Unreleased]` without checking the user-facing rule.** If the change has no user impact, leave `[Unreleased]` empty — that's fine. An empty `[Unreleased]` between releases is healthier than one polluted with internals.
