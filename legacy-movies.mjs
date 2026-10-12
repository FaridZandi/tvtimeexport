import { existsSync, readFileSync } from 'node:fs';

// RFC-style quoted fields, including commas/newlines and escaped quotes. Only hints are retained.
export function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (char === '\n') { rows.push(row); row = []; }
    } else field += char;
  }
  if (quoted) throw new Error('Incomplete source CSV');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function readMovieHints(path) {
  if (!path || !existsSync(path)) return new Map();
  try {
    const [headers = [], ...rows] = parseCSV(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const titleIndex = headers.indexOf('movie_name'), dateIndex = headers.indexOf('release_date');
    const years = new Map();
    if (titleIndex < 0 || dateIndex < 0) return years;
    for (const row of rows) {
      const title = row[titleIndex], match = /^(\d{4})-\d{2}-\d{2}/.exec(row[dateIndex] || '');
      if (!title || !match || Number(match[1]) < 1800 || Number(match[1]) > 2100) continue;
      if (!years.has(title)) years.set(title, new Set());
      years.get(title).add(match[1]);
    }
    return new Map([...years].map(([title, set]) => [title, [...set].sort()]));
  } catch { return new Map(); } // Optional hints never prevent reviewing the library.
}

export function legacyMovies(db, hints = new Map()) {
  return db.prepare(`SELECT legacy.*, l.tvdb_movie_id AS linked_provider_id, l.provider_title,
      l.year, l.country, l.runtime, l.poster_url, l.overview, l.linked_at,
      c.generated_at AS suggestions_at, c.error AS suggestions_error, c.matches_json AS suggestions_json
    FROM (
      SELECT title, MAX(watched) AS watched, MAX(watchlist) AS watchlist,
        SUM(event_count) AS event_count, SUM(watch_count) AS watch_count, MAX(last_activity) AS last_activity
      FROM (
        SELECT title, MAX(event_type='watch') AS watched, MAX(event_type IN ('towatch','watchlist')) AS watchlist,
          COUNT(*) AS event_count, SUM(event_type='watch') AS watch_count, MAX(event_at) AS last_activity
        FROM movie_events WHERE movie_key IS NULL GROUP BY title
        UNION ALL SELECT title, status='watched', status='watchlist', 0, 0, updated_at FROM custom_movies
      ) GROUP BY title
    ) legacy LEFT JOIN legacy_movie_links l ON l.legacy_title=legacy.title
    LEFT JOIN legacy_movie_suggestions c ON c.legacy_title=legacy.title
    ORDER BY legacy.title COLLATE NOCASE`).all().map(({ suggestions_json, ...row }) => ({ ...row, suggestions_count: suggestions_json ? JSON.parse(suggestions_json).length : null, source_years: hints.get(row.title) || [] }));
}

export function movieLibrary(db, hints = new Map()) {
  const grouped = new Map();
  for (const movie of db.prepare(`SELECT *, status='watched' AS watched, status='watchlist' AS watchlist, updated_at AS last_activity FROM provider_movies`).all()) {
    grouped.set(movie.movie_key, { ...movie, legacy_titles: [] });
  }
  for (const movie of legacyMovies(db, hints)) {
    const key = movie.linked_provider_id ? `tvdb-movie:${movie.linked_provider_id}` : `legacy:${movie.title}`;
    const prior = grouped.get(key);
    const identity = { legacy_title: movie.title, provider_id: movie.linked_provider_id, event_count: movie.event_count, watched: movie.watched, watchlist: movie.watchlist, source_years: movie.source_years };
    if (prior) {
      prior.watched = Math.max(prior.watched, movie.watched);
      prior.watchlist = Math.max(prior.watchlist, movie.watchlist);
      prior.last_activity = [prior.last_activity || '', movie.last_activity || ''].sort().at(-1);
      prior.legacy_titles.push(identity);
    } else grouped.set(key, { ...movie, title: movie.provider_title || movie.title,
      movie_key: movie.linked_provider_id ? key : null, tvdb_movie_id: movie.linked_provider_id,
      legacy_title: movie.title, legacy_titles: [identity] });
  }
  return [...grouped.values()].sort((a, b) => String(b.last_activity || '').localeCompare(String(a.last_activity || '')) || a.title.localeCompare(b.title));
}
