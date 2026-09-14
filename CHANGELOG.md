# Changelog

All notable changes to this plugin are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-09-14

### Fixed — scanning missed most of a folder's existing files

A folder that was added after the first-ever scan was collected with a **single
global anchor** (`last scan − 6h`), so everything older than that window was
never indexed — and never would be, because the anchor kept moving forward.
On the author's machine one watched folder held 570 files and only **13** of
them made it into the index. The fix makes the anchor **per folder**:

- `roots` now stores `last_scan_ms` and `first_scan_done` (schema `v2 → v3`,
  migrated automatically on open; existing installs are treated as *not yet
  backfilled*, so the next scan repairs them by itself).
- `syncRoots` upserts and **preserves** anchors instead of deleting and
  recreating the table on every run.
- New `firstScanMode` setting decides what a folder's first scan collects:
  `full` (default — the folder's whole history), `window` (last
  `firstRunWindowDays` days) or `none` (only files appearing from now on).
- `scanRoots` takes a per-folder window and reports **per-folder completion**;
  only folders that were actually walked to the end get their anchor advanced,
  so an interrupted or unreadable folder is retried next time instead of being
  skipped forever.
- `file_index_scan` gained `full: true` for a deliberate full rescan (the runner
  also accepts `--full`).

Verified on a real 9,876-file library: the index grew from 568 to 9,876 rows,
the folder above went from 13 to 560 rows, a second scan added **0** new rows
(idempotent), and a disk-vs-index diff found **0 missing and 0 stale** entries.

### Changed

- Settings page copy now matches the behaviour above (per-folder progress plus
  first-scan backfill) instead of the old "only files since the last scan" text.
- The "reading contents" note no longer claims document text is extracted (that
  is still on the roadmap — see `docs/`); image descriptions are what works today.
- `package.json`: added `repository` / `homepage` / `bugs` / `author` and
  keywords, `LICENSE` + `screenshots.json` added to `files`, and the official
  `@deepseek-ai/*` packages moved to `peerDependencies` as the plugin registry
  requires.

### Added

- Offline self-test (`tools/selftest.mjs`, run by `npm test`) covering per-folder
  backfill, incremental idempotency, interrupt safety and content-only search.
- GitHub Actions workflow running the suite on Node 22.x and 24.x with no
  install step, no network and no credentials.

## [0.1.0] — 2026-09-14

Initial release.

- Watches the folders you choose and records what appeared: name, type, size,
  appeared-at, location and origin, in a local SQLite database.
- Directory-level pruning (`node_modules`, VCS, caches, program folders) so a
  scan of tens of thousands of files takes seconds.
- Search with SQL hard filters (time / type / folder / origin) plus multi-keyword
  AND matching and hit-position weighting across name, tags, path, summary,
  image description and excerpt.
- Live fallback scan of the watched folders when the index has no hit.
- Image content can be reviewed by the model and written back as a description.
- Settings page: scan status, "scan now", folder list with per-folder depth,
  database location, interval, image quota, backup retention.
- **Read-only promise:** the plugin never modifies, moves or deletes your files.

[0.1.1]: https://github.com/wangzhanchao883/dsh-lost-and-found/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wangzhanchao883/dsh-lost-and-found/releases/tag/v0.1.0
