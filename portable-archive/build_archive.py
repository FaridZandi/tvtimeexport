#!/usr/bin/env python3
"""Build a small, service-independent archive from a TV Time GDPR export.

The source directory is read only.  Output deliberately excludes account,
device, analytics, social, and authentication/token data.
"""

from __future__ import annotations

import csv
import re
import shutil
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "gdpr-data"
OUTPUT = ROOT / "export"
DB = OUTPUT / "tvtime-archive.sqlite"

UUID = re.compile(r"uuid:([0-9a-f-]{36})")


def read_csv(filename: str) -> list[dict[str, str]]:
    with (SOURCE / filename).open(newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def truth(value: str) -> int | None:
    if value == "":
        return None
    return int(value.lower() in {"1", "true", "yes"})


def rating_code(row: dict[str, str]) -> str:
    return row["vote_key"].rsplit("-", 1)[-1] if row.get("vote_key") else ""


def write_csv(name: str, columns: list[str], rows: list[dict[str, object]]) -> None:
    with (OUTPUT / name).open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    if not SOURCE.is_dir():
        raise SystemExit(f"GDPR source folder not found: {SOURCE}")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True)

    user_shows = read_csv("user_tv_show_data.csv")
    followed = read_csv("followed_tv_show.csv")
    records_v2 = read_csv("tracking-prod-records-v2.csv")
    records_v1 = read_csv("tracking-prod-records.csv")

    # A show can appear in several source tables.  The TV Time show id is the
    # stable key in this export; later sources only fill in missing fields.
    shows: dict[str, dict[str, object]] = {}
    def ensure_show(show_id: str, title: str) -> dict[str, object]:
        key = f"tvtime:{show_id}" if show_id else f"title:{title}"
        return shows.setdefault(key, {
            "show_key": key, "tvtime_show_id": show_id, "title": title,
            "followed": None, "favorited": None, "archived": None,
            "episodes_seen_reported": None, "followed_at": None,
            "updated_at": None,
        })

    for row in user_shows:
        show = ensure_show(row["tv_show_id"], row["tv_show_name"])
        show.update({"followed": truth(row["is_followed"]),
                     "favorited": truth(row["is_favorited"]),
                     "episodes_seen_reported": int(row["nb_episodes_seen"] or 0)})
    for row in followed:
        show = ensure_show(row["tv_show_id"], row["tv_show_name"])
        show.update({"followed": truth(row["active"]), "archived": truth(row["archived"]),
                     "followed_at": row["created_at"], "updated_at": row["updated_at"]})
    for row in records_v2:
        if row["s_id"] and row["series_name"]:
            show = ensure_show(row["s_id"], row["series_name"])
            if row["is_followed"]:
                show["followed"] = truth(row["is_followed"])
            if row["is_archived"]:
                show["archived"] = truth(row["is_archived"])

    episode_watches: list[dict[str, object]] = []
    for row in records_v2:
        if not row["ep_id"]:
            continue
        show = ensure_show(row["s_id"], row["series_name"])
        key = row["key"]
        episode_watches.append({
            "source_key": key, "episode_tvtime_id": row["ep_id"],
            "show_key": show["show_key"], "show_title": row["series_name"],
            "season_number": row["season_number"], "episode_number": row["episode_number"],
            "watched_at": row["created_at"], "updated_at": row["updated_at"],
            "event_kind": "rewatch" if key.startswith("rewatch-") else "watch",
            "bulk_type": row["bulk_type"],
        })

    movie_events = [{
        "title": row["movie_name"], "event_type": row["type"],
        "event_key": row["type-uuid-n"], "event_at": row["created_at"],
        "updated_at": row["updated_at"], "watch_date": row["watch_date"],
        "rewatch_count": row["rewatch_count"],
    } for row in records_v1 if row["movie_name"]]

    ratings: list[dict[str, object]] = []
    emotions: list[dict[str, object]] = []
    for filename in ("ratings-live-votes.csv", "ratings-v2-prod-votes.csv", "ratings-3-prod-episode_votes.csv"):
        for row in read_csv(filename):
            ratings.append({"source_file": filename, "vote_key": row["vote_key"],
                            "rating_code": rating_code(row), "movie_title": row["movie_name"],
                            "show_title": row["series_name"], "season_number": row["season_number"],
                            "episode_number": row["episode_number"], "episode_tvtime_id": row["episode_id"]})
    for filename in ("emotions-live-votes.csv", "emotions-v2-prod-votes.csv", "emotions-3-prod-episode_votes.csv"):
        for row in read_csv(filename):
            emotions.append({"source_file": filename, "vote_key": row["vote_key"],
                             "emotion_code": rating_code(row), "movie_title": row["movie_name"],
                             "show_title": row["series_name"], "season_number": row["season_number"],
                             "episode_number": row["episode_number"], "episode_tvtime_id": row["episode_id"]})

    rewatch_rows = [{"show_title": r["tv_show_name"], "episode_tvtime_id": r["episode_id"],
                     "season_number": r["episode_season_number"], "episode_number": r["episode_number"],
                     "watch_count": r["cpt"], "recorded_at": r["created_at"]}
                    for r in read_csv("rewatched_episode.csv")]

    # Keep list memberships even when the source only gives an internal UUID.
    # Movie names are filled where that UUID occurs in the rating export.
    movie_by_uuid = {r["vote_key"].rsplit("-", 2)[0]: r["movie_title"]
                     for r in ratings if r["movie_title"] and r["vote_key"]}
    list_memberships: list[dict[str, object]] = []
    for row in read_csv("lists-prod-lists.csv"):
        if row["type"] != "list":
            continue
        for item_uuid in UUID.findall(row["objects"]):
            list_memberships.append({"list_name": row["name"], "list_key": row["s_key"],
                                     "item_type": "movie" if "movie" in row["s_key"] else "series",
                                     "source_uuid": item_uuid,
                                     "resolved_title": movie_by_uuid.get(item_uuid, "")})

    outputs = {
        "shows.csv": (list(next(iter(shows.values())).keys()), list(shows.values())),
        "episode_watches.csv": (list(episode_watches[0].keys()), episode_watches),
        "movie_events.csv": (list(movie_events[0].keys()), movie_events),
        "ratings.csv": (list(ratings[0].keys()), ratings),
        "emotions.csv": (list(emotions[0].keys()), emotions),
        "rewatches.csv": (list(rewatch_rows[0].keys()), rewatch_rows),
        "list_memberships.csv": (list(list_memberships[0].keys()), list_memberships),
    }
    for filename, (columns, rows) in outputs.items():
        write_csv(filename, columns, rows)

    con = sqlite3.connect(DB)
    try:
        for filename, (columns, _) in outputs.items():
            table = filename.removesuffix(".csv")
            con.execute(f'DROP TABLE IF EXISTS "{table}"')
            con.execute("CREATE TABLE \"%s\" (%s)" % (table, ", ".join(f'\"{c}\" TEXT' for c in columns)))
            with (OUTPUT / filename).open(newline="", encoding="utf-8") as file:
                records = list(csv.DictReader(file))
            con.executemany("INSERT INTO \"%s\" VALUES (%s)" % (table, ", ".join("?" * len(columns))),
                            [[record[column] for column in columns] for record in records])
        con.execute("CREATE INDEX episode_watches_position ON episode_watches(show_key, season_number, episode_number)")
        con.execute("CREATE INDEX movie_events_title ON movie_events(title)")
        con.commit()
    finally:
        con.close()

    print(f"Created {DB}")
    for filename, (_, rows) in outputs.items():
        print(f"  {filename}: {len(rows)} rows")


if __name__ == "__main__":
    main()
