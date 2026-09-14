# Contributing

Thanks for taking a look. This plugin has one rule that outranks everything else.

## The read-only promise

The plugin scans folders the user chose and writes **only** its own database. It
must never modify, move, rename, delete or re-timestamp a user file, and it must
never write extra data streams, thumbnails or sidecar files next to one.

If a change would need to touch a user file — even to "fix" a wrong file name —
it does not belong in this plugin.

## Getting set up

There is nothing to install: the plugin uses Node built-ins only
(`node:sqlite`, `node:fs`, `node:zlib`). Node `^22` or `>=24` is required.

```sh
npm test        # syntax check on every source file + offline self-test
```

`npm test` runs without DSH, without an API key, without a browser and without
network access, so a green run on a clean machine is expected. CI runs the same
command on Node 22.x and 24.x.

Inside a DSH checkout you can also link the working copy into a profile:

```sh
dsh plugin --profile web add link:/path/to/dsh-lost-and-found
```

## Layout

```
index.mjs            host entry: settings namespace, tools, scan dispatch
client.js            web client: the settings page section
config.mjs           defaults, pruning rules, run-snapshot helpers
db.mjs               SQLite schema, migrations and queries
core/scan.mjs        the walker (pruning, per-folder windows, per-folder result)
core/schedule.mjs    anchors and scheduling (computeSinceMs / rootSinceMs / isDue)
core/search.mjs      query building, scoring, live fallback scan
core/run-scan.mjs    scan runner entry point (its own process, PID-locked)
core/classify.mjs    file categories, origins, noise heuristic
core/format.mjs      human-readable sizes and times
tools/selftest.mjs   the offline suite
```

## Changing the schema

The database is derived data and may be rebuilt at any time, but installs are
long-lived, so:

1. Bump `SCHEMA_VERSION` in `db.mjs`.
2. Add the `ALTER TABLE` to `migrate()` — never require the user to delete the DB.
3. Make the migration outcome self-healing (a new column defaulting to "not done
   yet" should trigger the work on the next run rather than needing manual SQL).

## Adding or changing a scan rule

- Pruning is **directory-level**: a hit skips the whole subtree. Prefer that over
  per-file filtering, and remember a scan of tens of thousands of files is
  expected to stay in the seconds range.
- The scan runner must stay I/O-only and stay in its own process; the host process
  must not block on a walk.
- Any new per-source state (a window, a cursor, a cursor-like flag) belongs on the
  folder row, not in a global `meta` key — see the 0.1.1 entry in `CHANGELOG.md`
  for what a global anchor costs.

## Pull requests

- Keep the diff focused; one concern per PR.
- `npm test` must pass, and new behaviour should come with an assertion in
  `tools/selftest.mjs` — that suite is the project's regression net.
- Match the surrounding style: 2-space indent, double quotes, semicolons, and
  comments that explain *why* (the reasoning is the valuable part).
- If a user-visible string changes, update both the `zh` and the `en`
  dictionaries in `client.js`.

## License

By contributing you agree that your contribution is licensed under the MIT
License (see `LICENSE`).
