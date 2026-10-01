# ReelTime

ReelTime is a private, local-first TV and movie tracker built from a TV Time GDPR export. It keeps watch history, rewatches, show progress, upcoming episodes, and movie activity in a local SQLite database—without social features.

## Features

- Imports the useful, non-sensitive parts of a TV Time GDPR export.
- Tracks shows, episodes, rewatches, movies, ratings, and personal lists.
- Syncs episode guides, statuses, air dates, posters, and backdrops from TheTVDB.
- Provides show pages with season progress and one-click Watch/Rewatch actions.
- Displays upcoming followed-show releases in a three-month calendar.
- Keeps archived shows out of the active library while preserving all history.

## Requirements

- Node.js 24 or newer (the server uses Node's built-in SQLite support).
- A TheTVDB API key for metadata sync.
- A TV Time GDPR export in `gdpr-data/` when rebuilding the portable archive.

## Setup

Create a local `.env` file:

```env
THETVDB_API_KEY=your_key_here
```

`API_KEY` is also accepted for compatibility. The `.env` file is ignored by Git and must never be committed.

Start the app:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

On first start, the server copies `portable-archive/export/tvtime-archive.sqlite` to `data/reeltime.sqlite`. The latter is the writable local database used by the app.

## Importing TV Time data

The archive builder is in [portable-archive/build_archive.py](portable-archive/build_archive.py). It reads the sibling `gdpr-data/` directory and produces a credential-free SQLite archive plus CSV exports:

```bash
python3 portable-archive/build_archive.py
```

The builder intentionally excludes account credentials, tokens, devices, IP addresses, and analytics data. See [portable-archive/README.md](portable-archive/README.md) for the exported-table details.

## Syncing metadata

Use **Sync episode guides** in the app to refresh every show in the library. The server authenticates to TheTVDB using the key in `.env`; the browser never receives the key.

The sync stores provider metadata locally, including:

- Aired-order seasons and episodes
- Air dates and known future releases
- Show status and first-air year
- Posters, backdrops, and overviews

The calendar uses the cached local schedule for the next three months. It is built with the MIT-licensed FullCalendar Standard browser bundle.

## Data and privacy

These paths are intentionally ignored by Git:

- `gdpr-data/` and `gdpr-data.zip` — original personal export
- `portable-archive/export/` — generated personal archive
- `data/reeltime.sqlite` — local watch history and metadata cache
- `.env` — API credentials

Only application source, the archive builder, and documentation should be committed.

From App Manager, **Check database** runs SQLite's integrity check against the
live library. **Create snapshot** uses SQLite's online backup support and stores
a verified copy under the manager's ignored `.state/backups/` directory. Both
operations leave the live database and the original GDPR export in place.

## Development notes

The app has no external runtime service other than optional TheTVDB metadata sync and the FullCalendar browser CDN asset. Its API and UI live in:

- `server.mjs` — local HTTP server, SQLite storage, TheTVDB sync
- `public/app.js` — single-page UI
- `public/*.css` — presentation and component styling
