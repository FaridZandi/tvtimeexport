import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
function dotenv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(line => line && !line.trimStart().startsWith('#') && line.includes('='))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
}

// Importing the server never opens the private library. Tests supply their own database and provider.
export function createApp({ db, fetch = globalThis.fetch, config = dotenv } = {}) {
if (!db) throw new Error('A database is required');

db.exec(`
  CREATE TABLE IF NOT EXISTS custom_shows (
    show_key TEXT PRIMARY KEY, tvtime_show_id TEXT, title TEXT NOT NULL, followed TEXT DEFAULT '1',
    favorited TEXT DEFAULT '0', archived TEXT DEFAULT '0', episodes_seen_reported TEXT DEFAULT '0',
    followed_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS custom_movies (
    title TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'watchlist', rating_code TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_movies (
    movie_key TEXT PRIMARY KEY, tvdb_movie_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
    status TEXT NOT NULL, year TEXT, country TEXT, runtime INTEGER,
    poster_url TEXT, overview TEXT, studio TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS metadata_shows (
    tvdb_show_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT,
    next_aired TEXT, last_synced_at TEXT NOT NULL,
    poster_url TEXT, backdrop_url TEXT, overview TEXT, first_aired TEXT, airs_time TEXT
  );
  CREATE TABLE IF NOT EXISTS season_catalog (
    tvdb_show_id TEXT NOT NULL, season_number INTEGER NOT NULL, episode_count INTEGER NOT NULL,
    tvdb_season_id TEXT, title TEXT, poster_url TEXT,
    PRIMARY KEY (tvdb_show_id, season_number)
  );
  CREATE TABLE IF NOT EXISTS episode_catalog (
    tvdb_episode_id TEXT PRIMARY KEY, tvdb_show_id TEXT NOT NULL,
    season_number INTEGER NOT NULL, episode_number INTEGER NOT NULL,
    title TEXT, overview TEXT, aired_at TEXT, runtime INTEGER,
    is_special INTEGER NOT NULL DEFAULT 0, last_updated TEXT, synced_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS episode_catalog_show_position ON episode_catalog(tvdb_show_id, season_number, episode_number);
  CREATE INDEX IF NOT EXISTS episode_catalog_air_date ON episode_catalog(aired_at);
`);
// Databases created by the first development build did not have this nullable
// column. Keep the local database forward-compatible without touching imports.
if (!db.prepare('PRAGMA table_info(custom_shows)').all().some(column => column.name === 'tvtime_show_id')) {
  db.exec('ALTER TABLE custom_shows ADD COLUMN tvtime_show_id TEXT');
}
for (const [column, definition] of [['poster_url', 'TEXT'], ['backdrop_url', 'TEXT'], ['overview', 'TEXT'], ['first_aired', 'TEXT'], ['airs_time', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(metadata_shows)').all().some(entry => entry.name === column)) db.exec(`ALTER TABLE metadata_shows ADD COLUMN ${column} ${definition}`);
}

// Link new watch events to confirmed movie identities without guessing imported IDs.
if (!db.prepare('PRAGMA table_info(movie_events)').all().some(column => column.name === 'movie_key')) {
  db.exec('ALTER TABLE movie_events ADD COLUMN movie_key TEXT');
}

// Keep original records and watch history; removal only changes library membership.
db.exec(`
  CREATE TABLE IF NOT EXISTS removed_shows (show_key TEXT PRIMARY KEY, removed_at TEXT NOT NULL);
  CREATE VIEW IF NOT EXISTS library_shows AS
    SELECT show_key, tvtime_show_id, title, followed, favorited, archived, episodes_seen_reported, followed_at, updated_at FROM shows
    UNION ALL
    SELECT show_key, tvtime_show_id, title, followed, favorited, archived, episodes_seen_reported, followed_at, updated_at FROM custom_shows;
  CREATE VIEW IF NOT EXISTS active_shows AS
    SELECT * FROM library_shows WHERE NOT EXISTS (SELECT 1 FROM removed_shows r WHERE r.show_key=library_shows.show_key);
`);

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const rows = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

// The GDPR export contains a legacy Prison Break record (75340) alongside
// its current TVDB record (360115). Consolidate it once so progress remains
// attached to the episode guide that can actually be refreshed.
function mergeLegacyShow(fromKey, intoKey) {
  const source = one('SELECT * FROM shows WHERE show_key=?', fromKey);
  const target = one('SELECT * FROM shows WHERE show_key=?', intoKey);
  if (!source || !target) return;
  db.exec('BEGIN');
  try {
    run(`UPDATE shows SET
      followed=CASE WHEN followed='1' OR ?='1' THEN '1' ELSE '0' END,
      favorited=CASE WHEN favorited='1' OR ?='1' THEN '1' ELSE '0' END,
      archived=CASE WHEN archived='1' OR ?='1' THEN '1' ELSE '0' END,
      episodes_seen_reported=CAST(MAX(CAST(COALESCE(episodes_seen_reported, '0') AS INTEGER), CAST(COALESCE(?, '0') AS INTEGER)) AS TEXT),
      followed_at=COALESCE(followed_at, ?), updated_at=COALESCE(updated_at, ?)
      WHERE show_key=?`, source.followed, source.favorited, source.archived, source.episodes_seen_reported, source.followed_at, source.updated_at, intoKey);
    run('UPDATE episode_watches SET show_key=?, show_title=? WHERE show_key=?', intoKey, target.title, fromKey);
    run('DELETE FROM shows WHERE show_key=?', fromKey);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
mergeLegacyShow('tvtime:75340', 'tvtime:360115');

// Prison Break's old TV Time episode ids predate the current TVDB ids. Its
// season/episode positions still agree, so relink those watch events to the
// current catalogue instead of treating the show as unclassified.
function relinkPrisonBreakEpisodes() {
  run(`UPDATE episode_watches
    SET episode_tvtime_id=(SELECT c.tvdb_episode_id FROM episode_catalog c
      WHERE c.tvdb_show_id='360115' AND c.season_number=episode_watches.season_number
        AND c.episode_number=episode_watches.episode_number LIMIT 1)
    WHERE show_key='tvtime:360115' AND EXISTS (SELECT 1 FROM episode_catalog c
      WHERE c.tvdb_show_id='360115' AND c.season_number=episode_watches.season_number
        AND c.episode_number=episode_watches.episode_number)`);
}
relinkPrisonBreakEpisodes();

// This item is a film in the imported movie history, not a show to track.
run("DELETE FROM shows WHERE show_key='tvtime:75093'");

async function tvdbToken() {
  const env = config();
  const apikey = env.THETVDB_API_KEY || env.API_KEY;
  if (!apikey) throw new Error('Add THETVDB_API_KEY to .env before syncing episode data');
  const response = await fetch('https://api4.thetvdb.com/v4/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apikey }), signal: AbortSignal.timeout(30000) });
  const payload = await response.json();
  if (!response.ok || !payload.data?.token) throw new Error('TheTVDB login failed');
  return payload.data.token;
}

async function tvdbGet(url, token) {
  const response = await fetch(url.startsWith('http') ? url : `https://api4.thetvdb.com/v4${url}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  const payload = await response.json();
  if (!response.ok || payload.status !== 'success') throw new Error(payload.message || `TheTVDB request failed (${response.status})`);
  return payload.data;
}

async function loadGuide(id, token) {
  const series = await tvdbGet(`/series/${id}/extended`, token);
  if (!series || String(series.id) !== String(id) || !series.name) throw new Error('TheTVDB returned an invalid show');
  let pageUrl = `/series/${id}/episodes/default?page=0`;
  const episodes = [];
  const visited = new Set();
  while (pageUrl) {
    const endpoint = new URL(pageUrl.startsWith('/series/') ? `/v4${pageUrl}` : pageUrl, 'https://api4.thetvdb.com/v4/');
    if (endpoint.origin !== 'https://api4.thetvdb.com' || !endpoint.pathname.startsWith('/v4/series/')) throw new Error('Invalid episode page URL');
    if (visited.has(endpoint.href) || visited.size >= 1000) throw new Error('Invalid episode pagination');
    visited.add(endpoint.href);
    const response = await fetch(endpoint.href, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    const payload = await response.json();
    if (!response.ok || payload.status !== 'success') throw new Error(payload.message || `Episode request failed (${response.status})`);
    if (!Array.isArray(payload.data?.episodes)) throw new Error('TheTVDB returned an incomplete episode guide');
    for (const episode of payload.data.episodes) {
      if (!/^\d+$/.test(String(episode.id)) || !Number.isInteger(episode.seasonNumber) || episode.seasonNumber < 0 || !Number.isInteger(episode.number) || episode.number < 0) throw new Error('TheTVDB returned an invalid episode');
      episodes.push(episode);
    }
    pageUrl = payload.links?.next || null;
  }
  const uniqueEpisodes = [...new Map(episodes.map(e => [String(e.id), e])).values()];
  // Extended series include alternate orders. Only retain seasons in the default order.
  const seasons = new Map((series.seasons || [])
    .filter(season => season.type?.id === series.defaultSeasonType && Number.isInteger(season.number) && season.number >= 0)
    .map(season => [season.number, { ...season, episode_count: 0 }]));
  for (const episode of uniqueEpisodes) {
    if (!seasons.has(episode.seasonNumber)) seasons.set(episode.seasonNumber, { number: episode.seasonNumber, episode_count: 0 });
    seasons.get(episode.seasonNumber).episode_count++;
  }
  return { series, episodes: uniqueEpisodes, seasons: [...seasons.values()] };

}

function saveGuide(show, { series, episodes, seasons }, add = false, restore = false) {
  const syncedAt = now();
  db.exec('BEGIN');
  try {
    if (add) {
      run('INSERT INTO custom_shows (show_key, tvtime_show_id, title, followed_at, updated_at) VALUES (?, ?, ?, ?, ?)', show.show_key, show.tvtime_show_id, series.name, syncedAt, syncedAt);
    }
    const backdrop = (series.artworks || []).filter(artwork => artwork.type === 3).sort((a, b) => (b.score || 0) - (a.score || 0))[0]?.image || '';
    run(`INSERT INTO metadata_shows (tvdb_show_id, title, status, next_aired, last_synced_at, poster_url, backdrop_url, overview, first_aired, airs_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tvdb_show_id) DO UPDATE SET title=excluded.title, status=excluded.status, next_aired=excluded.next_aired, last_synced_at=excluded.last_synced_at, poster_url=excluded.poster_url, backdrop_url=excluded.backdrop_url, overview=excluded.overview, first_aired=excluded.first_aired, airs_time=excluded.airs_time`,
        String(show.tvtime_show_id), series.name || show.title, series.status?.name || '', series.nextAired || '', syncedAt, series.image || '', backdrop, series.overview || '', series.firstAired || '', series.airsTime || '');
    run('DELETE FROM season_catalog WHERE tvdb_show_id=?', String(show.tvtime_show_id));
    for (const season of seasons) run('INSERT INTO season_catalog VALUES (?, ?, ?, ?, ?, ?)', String(show.tvtime_show_id), season.number, season.episode_count, season.id == null ? null : String(season.id), season.name || '', season.image || '');
    run('DELETE FROM episode_catalog WHERE tvdb_show_id=?', String(show.tvtime_show_id));
    const insert = db.prepare('INSERT INTO episode_catalog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const episode of episodes) insert.run(String(episode.id), String(show.tvtime_show_id), Number(episode.seasonNumber ?? 0), Number(episode.number ?? 0), episode.name || '', episode.overview || '', episode.aired || '', episode.runtime ?? null, Number(episode.seasonNumber) === 0 ? 1 : 0, String(episode.lastUpdated || ''), syncedAt);
    if (restore) run('DELETE FROM removed_shows WHERE show_key=?', show.show_key);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return episodes.length;
}

async function syncShow(show, token) {
  return saveGuide(show, await loadGuide(show.tvtime_show_id, token));
}

const confirmations = new Map();
async function confirmShow(id) {
  if (confirmations.has(id)) return confirmations.get(id);
  const pending = (async () => {
    const existing = one('SELECT show_key, tvtime_show_id, title FROM library_shows WHERE tvtime_show_id=?', id);
    // A repeated confirmation of a fully synced identity is idempotent.
    if (existing && one('SELECT tvdb_show_id FROM metadata_shows WHERE tvdb_show_id=?', id) && one('SELECT tvdb_episode_id FROM episode_catalog WHERE tvdb_show_id=? LIMIT 1', id)) {
      run('DELETE FROM removed_shows WHERE show_key=?', existing.show_key);
      return { show_key: existing.show_key, existing: true, episodes: one('SELECT COUNT(*) AS n FROM episode_catalog WHERE tvdb_show_id=?', id).n };
    }
    const guide = await loadGuide(id, await tvdbToken());
    if (!guide.episodes.length) throw new Error('This show has no episodes available yet. Nothing was added; try again when its guide is available.');
    const show = existing || { show_key: `tvdb:${id}`, tvtime_show_id: id, title: guide.series.name };
    const episodes = saveGuide(show, guide, !existing, true);
    return { show_key: show.show_key, existing: Boolean(existing), episodes };
  })();
  confirmations.set(id, pending);
  try { return await pending; } finally { confirmations.delete(id); }
}

async function searchMatches(query, type) {
  const token = await tvdbToken();
  const results = await tvdbGet(`/search?query=${encodeURIComponent(query)}&type=${type}&limit=20`, token);
  if (!Array.isArray(results)) throw new Error('TheTVDB returned invalid search results');
  const normalizeTitle = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const q = normalizeTitle(query);
  const rank = result => {
    const names = [result.name, ...(Array.isArray(result.aliases) ? result.aliases : [])].map(normalizeTitle);
    return names.some(n => n === q) ? 3 : names.some(n => n.startsWith(q)) ? 2 : names.some(n => n.includes(q)) ? 1 : 0;
  };
  const matches = [...new Map(results.filter(r => (!r.type || r.type === type) && /^\d+$/.test(String(r.tvdb_id))).map(r => [String(r.tvdb_id), r])).values()]
    .sort((a, b) => rank(b) - rank(a)).slice(0, 3);
  return { token, matches };
}

async function searchShows(query) {
  const { token, matches } = await searchMatches(query, 'series');
  return Promise.all(matches.map(async result => {
    let seasonCount = null, episodeCount = null, countError = '';
    try {
      const guide = await loadGuide(result.tvdb_id, token);
      const regular = guide.episodes.filter(e => e.seasonNumber > 0);
      seasonCount = guide.seasons.filter(season => season.number > 0).length;
      episodeCount = regular.length;
    } catch { countError = 'Counts unavailable; confirmation will retry the full guide.'; }
    return { provider_id: String(result.tvdb_id), title: result.name || 'Untitled show',
      poster_url: result.image_url || result.thumbnail || '', year: result.year || '',
      country: result.country || '', network: result.network || '', overview: result.overview || '',
      season_count: seasonCount, episode_count: episodeCount, count_error: countError };
  }));
}

async function loadMovie(id, token) {
  const movie = await tvdbGet(`/movies/${id}/extended?meta=translations`, token);
  if (!movie || String(movie.id) !== String(id) || !movie.name) throw new Error('TheTVDB returned an invalid movie');
  return { title: movie.name, year: movie.year || movie.first_release?.date?.slice(0, 4) || '', country: movie.originalCountry || '',
    runtime: Number.isInteger(movie.runtime) && movie.runtime > 0 ? movie.runtime : null,
    poster_url: movie.image || '', overview: movie.overview || movie.translations?.overviewTranslations?.find(item => item.language === 'eng')?.overview || '',
    studio: (movie.studios || []).map(studio => studio.name).filter(Boolean).join(', ') };
}

async function searchMovies(query) {
  const { token, matches } = await searchMatches(query, 'movie');
  return Promise.all(matches.map(async result => {
    let details = {}, detailsError = '';
    try { details = await loadMovie(result.tvdb_id, token); }
    catch { detailsError = 'Extra details unavailable; confirmation will retry.'; }
    return { provider_id: String(result.tvdb_id), title: result.name || details.title || 'Untitled movie',
      year: result.year || details.year || '', country: result.country || details.country || '',
      poster_url: result.image_url || result.thumbnail || details.poster_url || '',
      overview: result.overview || details.overview || '', director: result.director || '',
      studio: details.studio || '', runtime: details.runtime ?? null, details_error: detailsError };
  }));
}

async function confirmMovie(id, requestedStatus) {
  const movie = await loadMovie(id, await tvdbToken());
  const key = `tvdb-movie:${id}`, timestamp = now();
  // Read after the provider request so concurrent confirmations see earlier commits.
  const existing = one('SELECT * FROM provider_movies WHERE tvdb_movie_id=?', id);
  const status = existing?.status === 'watched' ? 'watched' : requestedStatus;
  db.exec('BEGIN');
  try {
    run(`INSERT INTO provider_movies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tvdb_movie_id) DO UPDATE SET title=excluded.title, status=excluded.status,
      year=excluded.year, country=excluded.country, runtime=excluded.runtime, poster_url=excluded.poster_url,
      overview=excluded.overview, studio=excluded.studio, updated_at=excluded.updated_at`,
      key, id, movie.title, status, movie.year, movie.country, movie.runtime, movie.poster_url, movie.overview, movie.studio, timestamp, timestamp);
    if (status === 'watched' && existing?.status !== 'watched') {
      run(`INSERT INTO movie_events (title, event_type, event_key, event_at, updated_at, watch_date, rewatch_count, movie_key)
        VALUES (?, 'watch', ?, ?, ?, ?, '', ?)`, movie.title, `local-${crypto.randomUUID()}`, timestamp, timestamp, timestamp, key);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { movie_key: key, existing: Boolean(existing), title: movie.title, status };
}

async function syncFollowedShows() {
  const shows = rows(`SELECT show_key, tvtime_show_id, title FROM active_shows WHERE tvtime_show_id != ''`);
  const token = await tvdbToken();
  const result = { synced: 0, episodes: 0, failures: [] };
  for (const show of shows) {
    try { result.episodes += await syncShow(show, token); result.synced++; }
    catch (error) { result.failures.push({ title: show.title, error: error.message }); }
  }
  relinkPrisonBreakEpisodes();
  return result;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function cleanText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return text.slice(0, 200);
}

function dashboard() {
  const stats = {
    shows: one(`SELECT COUNT(*) AS n FROM active_shows`).n,
    following: one(`SELECT COUNT(*) AS n FROM active_shows WHERE followed = '1' AND archived != '1'`).n,
    episodes: one(`SELECT COUNT(*) AS n FROM episode_watches`).n,
    moviesWatched: one(`SELECT COUNT(DISTINCT COALESCE(movie_key, 'title:' || title)) AS n FROM movie_events WHERE event_type = 'watch'`).n,
    watchlistMovies: one(`SELECT COUNT(DISTINCT title) AS n FROM movie_events WHERE event_type IN ('towatch', 'watchlist')`).n + one(`SELECT COUNT(*) AS n FROM custom_movies WHERE status = 'watchlist'`).n + one(`SELECT COUNT(*) AS n FROM provider_movies WHERE status='watchlist'`).n,
  };
  const recent = rows(`
    SELECT w.show_title AS title, 'Episode' AS kind, w.season_number, w.episode_number, w.watched_at AS occurred_at, CASE WHEN EXISTS(SELECT 1 FROM removed_shows r WHERE r.show_key=w.show_key) THEN NULL ELSE w.show_key END AS show_key, m.first_aired
    FROM episode_watches w LEFT JOIN library_shows s ON s.show_key=w.show_key LEFT JOIN metadata_shows m ON m.tvdb_show_id=s.tvtime_show_id
    UNION ALL
    SELECT title, 'Movie' AS kind, '', '', COALESCE(watch_date, event_at), NULL, NULL FROM movie_events WHERE event_type = 'watch'
    ORDER BY occurred_at DESC LIMIT 10
  `);
  const continueWatching = rows(`
    SELECT s.title, s.show_key, m.poster_url, m.first_aired, MAX(e.watched_at) AS last_watched,
           (SELECT 'S' || e2.season_number || 'E' || e2.episode_number FROM episode_watches e2 WHERE e2.show_key=s.show_key ORDER BY e2.watched_at DESC, e2.rowid DESC LIMIT 1) AS latest_episode
    FROM active_shows s JOIN episode_watches e ON e.show_key=s.show_key LEFT JOIN metadata_shows m ON m.tvdb_show_id=s.tvtime_show_id
    WHERE s.followed='1' AND s.archived != '1'
    GROUP BY s.show_key ORDER BY last_watched DESC LIMIT 8
  `);
  return { stats, recent, continueWatching };
}

function api(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/shows/search') {
    const query = cleanText(url.searchParams.get('q'), 'Search');
    return searchShows(query).then(matches => json(res, 200, matches));
  }
  if (req.method === 'GET' && path === '/api/movies/search') {
    const query = cleanText(url.searchParams.get('q'), 'Search');
    return searchMovies(query).then(matches => json(res, 200, matches));
  }
  if (req.method === 'GET' && path === '/api/shows/removed') {
    return json(res, 200, rows(`SELECT s.show_key, s.title, s.tvtime_show_id, r.removed_at,
      (SELECT COUNT(*) FROM episode_watches w WHERE w.show_key=s.show_key) AS watch_count
      FROM library_shows s JOIN removed_shows r ON r.show_key=s.show_key ORDER BY r.removed_at DESC, s.title`));
  }
  if (req.method === 'POST' && /^\/api\/shows\/[^/]+\/(remove|restore)$/.test(path)) return body(req).then(input => {
    const action = path.endsWith('/remove') ? 'remove' : 'restore';
    const key = decodeURIComponent(path.slice('/api/shows/'.length, -(action.length + 1)));
    const show = one('SELECT title FROM library_shows WHERE show_key=?', key);
    if (!show) return json(res, 404, { error: 'Show not found' });
    if (action === 'remove') {
      if (input.confirm_title !== show.title) return json(res, 400, { error: 'Type the exact show title to confirm removal' });
      run('INSERT INTO removed_shows VALUES (?, ?) ON CONFLICT(show_key) DO NOTHING', key, now());
    } else {
      run('DELETE FROM removed_shows WHERE show_key=?', key);
    }
    return json(res, 200, { ok: true, show_key: key, history_preserved: true });
  });
  if (req.method === 'GET' && path === '/api/dashboard') return json(res, 200, dashboard());
  if (req.method === 'GET' && path === '/api/shows') {
    const q = (url.searchParams.get('q') || '').trim();
    const filter = `%${q}%`;
    return json(res, 200, rows(`
      SELECT library.*, m.poster_url, m.backdrop_url, m.next_aired, m.status, m.first_aired, (SELECT COUNT(*) FROM episode_watches e WHERE e.show_key = library.show_key) AS logged_episodes,
      (SELECT COUNT(*) FROM episode_catalog e WHERE e.tvdb_show_id=library.tvtime_show_id AND e.is_special=0 AND e.aired_at != '' AND date(e.aired_at) <= date('now')) AS available_episodes,
      (SELECT COUNT(DISTINCT w.episode_tvtime_id) FROM episode_watches w JOIN episode_catalog e ON e.tvdb_episode_id=w.episode_tvtime_id WHERE e.tvdb_show_id=library.tvtime_show_id AND e.is_special=0 AND e.aired_at != '' AND date(e.aired_at) <= date('now')) AS catalog_watched_episodes,
      (SELECT MAX(watched_at) FROM episode_watches e WHERE e.show_key = library.show_key) AS last_watched
      FROM active_shows library LEFT JOIN metadata_shows m ON m.tvdb_show_id=library.tvtime_show_id
      WHERE library.title LIKE ? ORDER BY library.archived, library.followed DESC, library.title COLLATE NOCASE`, filter));
  }
  if (req.method === 'GET' && path === '/api/movies') {
    return json(res, 200, rows(`
      SELECT title, MAX(CASE WHEN event_type='watch' THEN 1 ELSE 0 END) AS watched,
             MAX(CASE WHEN event_type IN ('towatch','watchlist') THEN 1 ELSE 0 END) AS watchlist,
             MAX(event_at) AS last_activity, NULL AS movie_key, NULL AS tvdb_movie_id,
             NULL AS year, NULL AS country, NULL AS runtime, NULL AS poster_url, NULL AS overview
      FROM movie_events WHERE movie_key IS NULL GROUP BY title
      UNION ALL SELECT title, status='watched', status='watchlist', updated_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM custom_movies
      UNION ALL SELECT title, status='watched', status='watchlist', updated_at, movie_key, tvdb_movie_id, year, country, runtime, poster_url, overview FROM provider_movies
      ORDER BY last_activity DESC, title COLLATE NOCASE`));
  }
  if (req.method === 'GET' && path === '/api/history') {
    return json(res, 200, rows(`
      SELECT show_title AS title, 'episode' AS type, season_number, episode_number, event_kind, watched_at AS occurred_at FROM episode_watches
      UNION ALL SELECT title, 'movie', '', '', event_type, COALESCE(watch_date,event_at) FROM movie_events
      ORDER BY occurred_at DESC LIMIT 250`));
  }
  if (req.method === 'GET' && path === '/api/upcoming') {
    return json(res, 200, rows(`
      SELECT e.tvdb_episode_id, e.tvdb_show_id, s.show_key, s.title AS show_title, m.poster_url, e.season_number, e.episode_number, e.title, e.aired_at, e.runtime,
             EXISTS(SELECT 1 FROM episode_watches w WHERE w.episode_tvtime_id=e.tvdb_episode_id) AS watched
      FROM episode_catalog e JOIN active_shows s ON s.tvtime_show_id=e.tvdb_show_id LEFT JOIN metadata_shows m ON m.tvdb_show_id=e.tvdb_show_id
      WHERE s.followed='1' AND s.archived != '1' AND e.is_special=0 AND date(e.aired_at) >= date('now') AND date(e.aired_at) < date('now', '+3 months')
      ORDER BY e.aired_at, s.title, e.season_number, e.episode_number LIMIT 100`));
  }
  if (req.method === 'GET' && /^\/api\/shows\/[^/]+\/episodes$/.test(path)) {
    const key = decodeURIComponent(path.slice('/api/shows/'.length, -'/episodes'.length));
    const show = one(`SELECT show_key, tvtime_show_id, title, followed, archived FROM active_shows WHERE show_key=?`, key);
    if (!show) return json(res, 404, { error: 'Show not found' });
    const metadata = one('SELECT * FROM metadata_shows WHERE tvdb_show_id=?', show.tvtime_show_id) || null;
    const episodes = rows(`SELECT e.*, (SELECT COUNT(*) FROM episode_watches w WHERE w.episode_tvtime_id=e.tvdb_episode_id) AS watch_count
      FROM episode_catalog e WHERE e.tvdb_show_id=? ORDER BY e.season_number, e.episode_number`, show.tvtime_show_id);
    const seasons = rows('SELECT * FROM season_catalog WHERE tvdb_show_id=? ORDER BY season_number', show.tvtime_show_id);
    const watch_count = one('SELECT COUNT(*) AS n FROM episode_watches WHERE show_key=?', key).n;
    return json(res, 200, { show, metadata, seasons, episodes, watch_count });
  }
  if (req.method === 'POST' && path === '/api/sync/shows') return syncFollowedShows().then(result => json(res, 200, result));
  if (req.method === 'POST' && path === '/api/shows') return body(req).then(async input => {
    const id = String(input.provider_id || '');
    if (!/^\d+$/.test(id)) throw new Error('Select and confirm a TheTVDB match before adding a show');
    const result = await confirmShow(id);
    json(res, result.existing ? 200 : 201, result);
  });
  if (req.method === 'PATCH' && path.startsWith('/api/shows/')) return body(req).then(input => {
    const key = decodeURIComponent(path.slice('/api/shows/'.length));
    if (!['followed', 'favorited', 'archived'].includes(input.field)) throw new Error('Unsupported show field');
    const value = input.value ? '1' : '0';
    if (!one('SELECT show_key FROM active_shows WHERE show_key=?', key)) return json(res, 404, { error: 'Show not found in library' });
    const inSeed = one('SELECT show_key FROM shows WHERE show_key=?', key);
    run(`UPDATE ${inSeed ? 'shows' : 'custom_shows'} SET ${input.field}=?, updated_at=? WHERE show_key=?`, value, now(), key);
    json(res, 200, { ok: true });
  });
  if (req.method === 'POST' && path === '/api/episodes/watch') return body(req).then(input => {
    const showKey = cleanText(input.show_key, 'Show'); const season = Number(input.season); const episode = Number(input.episode);
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) throw new Error('Season and episode must be valid numbers');
    const show = one(`SELECT title FROM active_shows WHERE show_key=?`, showKey);
    if (!show) throw new Error('Show not found');
    run('INSERT INTO episode_watches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', `local-${crypto.randomUUID()}`, '', showKey, show.title, String(season), String(episode), now(), now(), input.rewatch ? 'rewatch' : 'watch', 'manual');
    json(res, 201, { ok: true });
  });
  if (req.method === 'POST' && /^\/api\/episodes\/[^/]+\/watch$/.test(path)) return body(req).then(input => {
    const episodeId = decodeURIComponent(path.slice('/api/episodes/'.length, -'/watch'.length));
    const episode = one(`SELECT e.tvdb_episode_id, e.tvdb_show_id, e.season_number, e.episode_number, m.title AS show_title
      FROM episode_catalog e JOIN metadata_shows m ON m.tvdb_show_id=e.tvdb_show_id WHERE e.tvdb_episode_id=?`, episodeId);
    if (!episode) throw new Error('Episode not found in the local guide');
    const show = one(`SELECT show_key FROM active_shows WHERE tvtime_show_id=?`, episode.tvdb_show_id);
    if (!show) throw new Error('This episode is not linked to a show in your library');
    const kind = input.rewatch ? 'rewatch' : 'watch';
    run('INSERT INTO episode_watches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', `local-${crypto.randomUUID()}`, episode.tvdb_episode_id, show.show_key, episode.show_title, String(episode.season_number), String(episode.episode_number), now(), now(), kind, 'manual');
    json(res, 201, { ok: true, watch_count: one('SELECT COUNT(*) AS n FROM episode_watches WHERE episode_tvtime_id=?', episodeId).n });
  });
  if (req.method === 'POST' && path === '/api/movies') return body(req).then(async input => {
    const id = String(input.provider_id || '');
    if (!/^\d+$/.test(id)) throw new Error('Select and confirm a TheTVDB match before adding a movie');
    if (!['watched', 'watchlist'].includes(input.status)) throw new Error('Choose watched or watchlist');
    const result = await confirmMovie(id, input.status);
    json(res, result.existing ? 200 : 201, result);
  });
  return json(res, 404, { error: 'Not found' });
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
return createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(root, 'public', requested));
    if (!file.startsWith(join(root, 'public')) || !existsSync(file)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(await import('node:fs/promises').then(fs => fs.readFile(file)));
  } catch (error) {
    const detail = error.cause?.code ? `${error.message || 'Request failed'} (${error.cause.code})` : (error.message || 'Request failed');
    json(res, 400, { error: detail });
  }
 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const port = Number(process.env.PORT || 3000);
  const dataDir = join(root, 'data');
  const dbPath = join(dataDir, 'reeltime.sqlite');
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(dbPath)) copyFileSync(join(root, 'portable-archive', 'export', 'tvtime-archive.sqlite'), dbPath);
  const db = new DatabaseSync(dbPath);
  createApp({ db }).listen(port, '127.0.0.1', () => console.log(`ReelTime is running at http://127.0.0.1:${port}`));
}
