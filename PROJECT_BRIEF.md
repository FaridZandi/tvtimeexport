# ReelTime project brief

Last verified: 2026-10-12 against source, fixture tests, and the restarted app
(read-only search/endpoint/UI checks; live add/removal writes were not performed).

## Purpose and orientation

ReelTime is a private, local-first TV/movie tracker seeded from a TV Time GDPR
export. It preserves watch/rewatch history, show progress, archived shows, movie
activity, and cached episode guides. The recorded product direction is local
storage without social features ([README.md](README.md)); this is documented
intent. The user explicitly requested that show removal take deliberate effort
and preserve watch history; see REEL-007 in TODO.md. No standalone historical plans
were found in the project.

Read [AGENTS.md](AGENTS.md) for workflow and [TODO.md](TODO.md) for the canonical
current work, priorities, dependencies, and evidence. Current work concerns sync
failure detail, isolated database/API coverage, and snapshot recovery; consult the
backlog rather than treating this summary as task status. The recent sync-control
fix is recorded in TODO.md and commit `f2267c7` (four simulated UI tests).

## Run and entry points

From the project root, use Node.js 24+ and `npm start` (equivalent to
`node server.mjs`). Open `http://127.0.0.1:3000/`; `PORT=3001 npm start` changes
the port. Binding is always `127.0.0.1`. There are no npm runtime dependencies or build
step in [package.json](package.json). Playwright 1.62.1 is a pinned development
dependency for browser checks (`npm ci`, `npx playwright install chromium`).

A fresh checkout needs the private seed `portable-archive/export/tvtime-archive.sqlite`
before first startup; an existing `data/reeltime.sqlite` bypasses that copy.
To build the seed from an available `gdpr-data/` export, run
`python3 portable-archive/build_archive.py` (Python standard library only).
This is an explicit rebuild operation, not a development check: it removes the
existing generated `export/` directory first. See the
[archive guide](portable-archive/README.md) for source/export semantics.

Server source changes require a process restart: App Manager does not reload the
Node server automatically. After publishing server changes, use App Manager's
ReelTime **Restart** (CLI: `python3 ../../appmanager.py restart reeltime`) and verify
the changed endpoint against the running app. New browser assets can load while
an older process still serves old API handlers; a search endpoint returning 404
was resolved by restart on 2026-10-12. A browser reload may also be needed.

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
  and TheTVDB v4 login/search/metadata requests. `createApp({db, fetch, config})`
  allows fixture tests to inject a database and provider; importing the module
  does not open the private library. GET routes serve dashboard, shows,
  movies, history, upcoming releases, and show episode details. POST/PATCH routes
  add items, update show flags, remove/restore library membership, log watches, and sync guides.
- [public/app.js](public/app.js): vanilla JavaScript hash-routed UI;
  [public/show-search.js](public/show-search.js) exports `mountMediaSearch` for the
  shared show/movie search dialog, selection, status choice and stale-response guards.
  Show pages include a collapsed
  Manage show section with typed-title removal confirmation; the library includes
  a Removed shows restore section. The UI uses those
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

Movie search uses GET `/api/movies/search` with TheTVDB movie-only search and
extended details/translations. It reuses show ranking and previews at most three
matches with identifying details and nullable runtime. POST `/api/movies` now
requires a confirmed `provider_id` and `status` (`watchlist` or `watched`), replacing
title-only creation. `provider_movies` stores stable identities and metadata;
`movie_events.movie_key` is a new nullable column linking confirmed watch events.
Confirmation saves metadata/status/event together in a transaction. Repeated or
concurrent confirmation does not duplicate movies or watches; watched entries never
downgrade to watchlist. Same-name provider IDs remain distinct. Imported events
and old `custom_movies` stay intact, unlinked, and appear as title-only entries;
they are not automatically merged with provider movies. Movie cards now show
poster/year/country/runtime/synopsis for confirmed entries. Dashboard movie counts
use provider keys where available; old records retain title-based counting.

Removal preserves original records and caches. `removed_shows` stores membership
tombstones; `library_shows` combines imported/custom records and `active_shows`
excludes tombstones. Library counts, queue, upcoming, watches and bulk sync use
active membership. History/recent activity keep prior watches; removed entries
lose their recent-activity navigation link. Removed show routes offer a library
return/restore hint. GET `/api/shows/removed` lists restorable entries; POST
`/api/shows/:key/remove` requires an exact `confirm_title`, while `/restore`
clears the tombstone without changing flags or history. Re-confirming a provider
identity reuses/restores it. Upcoming responses carry the actual `show_key` so
custom entries navigate correctly. No permanent-delete operation is provided.

Sync processes imported shows with nonempty provider IDs, including archived or
unfollowed shows, despite its internal function name. Bulk sync includes provider-linked custom shows and excludes removed entries. Existing title-only custom shows remain untouched and cannot sync until they have a provider identity.
Add Show searches up to 20 provider results, ranks exact/alias, prefix and substring
matches ahead of the provider's remaining order, and previews at most three.
Preview counts come from the complete default-order guide (including announced
empty seasons in that order, excluding specials); retrieval failure shows unknown.
Confirmation accepts a provider ID and atomically stores custom identity, metadata,
default-order seasons in `season_catalog`, and all paginated episodes. Empty guides
are rejected. Failures save nothing and allow retry; existing identities/history
are preserved and concurrent/repeated confirmations reuse one show.
Each successful guide replacement is transactional; other shows may fail
independently. The bulk-sync UI currently reports only the failure count.
Upcoming data covers followed, unarchived imported shows, excludes specials, and is
limited to 100 releases over the next three months; provider-linked custom shows
are included. Ratings/emotions remain raw codes and imported movie external IDs/list-title
resolution are incomplete (archive guide).

## Verify and maintain

Run from the root:

```sh
node --check server.mjs
node --check public/app.js
node --check public/show-search.js
npm test
npm run test:browser
```

These passed on 2026-10-12 with Node 24.7.0: 22 tests (18 isolated
provider/API/SQLite tests and four VM UI sync regressions), plus eight Chromium
browser tests at 1280px and 390px. Fixture teardown removes temporary databases.
Browser checks cover typing, ranked cards, artwork fallback, keyboard selection and
confirmation, loading/error/no-results feedback, stale/reopened searches, retry,
no horizontal dialog overflow, populated show pages, tucked-away removal, exact
title guards, duplicate entry targeting, removal/restore retries, preserved history
and restoration of progress. Movie checks cover both entry points, status choice,
ranked remakes, unknown details, keyboard confirmation, pending state, error retry
and stale-query/tab/modal guards. Fixture screenshots were
visually reviewed. `npm ci --ignore-scripts` also passed against the lockfile.
Tests require loopback sockets; the sandbox needed an approved escalation.
The fixture checks mock provider responses and block browser remote requests.
On 2026-10-12 the managed app restarted successfully; live read-only provider search
returned three populated matches and the existing Chrome dialog displayed Pantheon
results. The managed app was restarted again for removal; dashboard and removed-show
endpoints returned HTTP 200, and an older title-only entry displayed Manage show
and its removal action. A further restart enabled movies: live Dune search returned
HTTP 200 with three previews and runtimes, and Chrome displayed suggestions with
status choice/disabled confirmation. No live add/remove/restore was performed. Restart runs normal startup
migrations, but private-data integrity was not separately checked. CDN/calendar,
archive rebuilding and snapshot/restore remain unverified. Provider capabilities were checked against
[TheTVDB v4 schema](https://github.com/thetvdb/v4-api/blob/main/docs/swagger.yml).

Before changing this brief, re-read TODO.md and inspect Git changes. Maintain it
when entry points, commands, architecture, dependencies, persistence, or established
decisions change; update the verification date and limits. Keep secrets/personal
records out, link supporting sources, label uncertainties, and leave task tracking
in TODO.md. The reviewed branch is `main` tracking `origin/main`; re-check rather
than assuming that state persists.
