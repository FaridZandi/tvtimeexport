# ReelTime project brief

Last verified: 2026-10-11 against source, configuration, and local checks.

## Purpose and orientation

ReelTime is a private, local-first TV/movie tracker seeded from a TV Time GDPR
export. It preserves watch/rewatch history, show progress, archived shows, movie
activity, and cached episode guides. The recorded product direction is local
storage without social features ([README.md](README.md)); this is documented
intent, not evidence of additional personal preferences. No other user preferences
or standalone historical plans were found in the project.

Read [AGENTS.md](AGENTS.md) for workflow and [TODO.md](TODO.md) for the canonical
current work, priorities, dependencies, and evidence. Current work concerns sync
failure detail, isolated database/API coverage, and snapshot recovery; consult the
backlog rather than treating this summary as task status. The recent sync-control
fix is recorded in TODO.md and commit `f2267c7` (four simulated UI tests).

## Run and entry points

From the project root, use Node.js 24+ and `npm start` (equivalent to
`node server.mjs`). Open `http://127.0.0.1:3000/`; `PORT=3001 npm start` changes
the port. Binding is always `127.0.0.1`. There are no npm dependencies or build
step in [package.json](package.json).

A fresh checkout needs the private seed `portable-archive/export/tvtime-archive.sqlite`
before first startup; an existing `data/reeltime.sqlite` bypasses that copy.
To build the seed from an available `gdpr-data/` export, run
`python3 portable-archive/build_archive.py` (Python standard library only).
This is an explicit rebuild operation, not a development check: it removes the
existing generated `export/` directory first. See the
[archive guide](portable-archive/README.md) for source/export semantics.

Optional metadata sync requires `THETVDB_API_KEY=…` in the root `.env`;
`API_KEY` is a compatibility alias. The server reads that file itself; exporting
those keys into the shell alone does not configure sync. Never commit credentials.

The browser routes are `#dashboard`, `#shows`, `#upcoming`, `#movies`, `#history`,
and `#show/<encoded-show-key>`. App Manager also launches the server and uses
`GET /api/dashboard` for health. Its entry is in
[manager apps.json](../../apps.json); manager ownership is outside this repository.

## Architecture and dependencies

- [server.mjs](server.mjs): Node HTTP/static server, JSON `/api/*` routes,
  synchronous `node:sqlite` access, startup schema upgrades/data corrections,
  and TheTVDB v4 login/metadata requests. GET routes serve dashboard, shows,
  movies, history, upcoming releases, and show episode details. POST/PATCH routes
  add items, update show flags, log watches, and sync guides.
- [public/app.js](public/app.js): vanilla JavaScript hash-routed UI using those
  APIs; [public/index.html](public/index.html) loads component CSS and the
  FullCalendar 6.1.21 Standard browser bundle from jsDelivr. Calendar rendering
  needs that CDN asset; metadata artwork URLs also load remotely in the browser.
- [portable-archive/build_archive.py](portable-archive/build_archive.py): independent
  Python CSV-to-SQLite/CSV importer. Imported tables include shows, episode watches,
  movie events, ratings, emotions, rewatches, and list memberships. The server adds
  custom shows/movies and cached metadata/catalog tables.

TheTVDB owns provider data and authentication; sync is optional for local history.
App Manager owns process management and manual integrity/snapshot actions; ReelTime
has no runtime import of manager code. No other service dependency is configured.

## Persistence and pitfalls

[.gitignore](.gitignore) excludes `gdpr-data/`, `gdpr-data.zip`,
`portable-archive/export/`, local SQLite files/sidecars under `data/`, and `.env`.
Exports omit authentication/device/analytics data but still contain personal viewing
history: credential-free does not mean public.

Startup copies the seed only when the live database is absent. Rebuilding the
archive does not update the live library. The server writes directly to that live
database, including imported show flags and watch events; startup also performs
hard-coded legacy-show/episode corrections. Do not launch it against private data
merely to check syntax. There is no configurable database path or automatic backup.

App Manager's **Check database** opens the live database read-only for SQLite
integrity checking. **Create snapshot** uses SQLite online backup, verifies the
copy, and writes a timestamped file to the manager's `.state/backups/` directory.
Ownership and behavior were checked in [dashboard.py](../../dashboard.py) and
[tools/data_ops.py](../../tools/data_ops.py). Recovery remains unverified; use the
canonical backlog before proposing a restore procedure.

Sync processes imported shows with nonempty provider IDs, including archived or
unfollowed shows, despite its internal function name. New custom shows have no
provider ID and are not included. Each successful guide replacement is transactional;
other shows may fail independently. The UI currently reports only the failure count.
Upcoming data covers followed, unarchived imported shows, excludes specials, and is
limited to 100 releases over the next three months. Ratings/emotions remain raw
codes and movie external IDs/list-title resolution are incomplete (archive guide).

## Verify and maintain

Run from the root:

```sh
node --check server.mjs
node --check public/app.js
npm test
```

These passed on the last-verified date with Node 24.7.0: four UI sync tests using
VM/DOM/fetch stubs. They do not exercise SQLite, real browser rendering, live
TheTVDB/CDN access, archive rebuilding, or snapshot/restore operations. This brief's
run/data claims were checked against code/configuration, without opening private
data or starting the live server; those runtime paths remain unverified here.

Before changing this brief, re-read TODO.md and inspect Git changes. Maintain it
when entry points, commands, architecture, dependencies, persistence, or established
decisions change; update the verification date and limits. Keep secrets/personal
records out, link supporting sources, label uncertainties, and leave task tracking
in TODO.md. At this review the branch was `main` tracking `origin/main`, with only
AGENTS.md and TODO.md untracked before assignment edits; re-check rather than
assuming that state persists.
