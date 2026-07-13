# Portable TV Time archive

Run `python3 build_archive.py` from this directory to rebuild `export/` from
the sibling `gdpr-data/` folder. The builder reads only the watch/library,
rating, emotion, rewatch, and list data. It intentionally excludes profile,
social, device, analytics, and authentication/token files.

`export/tvtime-archive.sqlite` is the primary portable archive. The same data
is also supplied as UTF-8 CSV files for importing elsewhere:

- `shows.csv` — current show library/status, with TV Time show IDs.
- `episode_watches.csv` — one source record per episode-watch action; repeats
  are preserved and marked as `watch` or `rewatch`.
- `movie_events.csv` — watched, to-watch, followed, and rewatch-related movie
  events. Movies have titles but no reliable external IDs in the source.
- `ratings.csv` and `emotions.csv` — raw TV Time vote codes. The GDPR export
  does not provide a code-to-label mapping, so these are intentionally not
  converted to star scores or emotion names.
- `rewatches.csv` — TV Time's per-episode rewatch count records.
- `list_memberships.csv` — favorite-list entries. Some titles cannot be
  resolved because the original lists contain only internal UUIDs.

The original GDPR export is not modified.
