import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const dataDir = join(root, 'data');
const dbPath = join(dataDir, 'reeltime.sqlite');
const seedPath = join(root, 'portable-archive', 'export', 'tvtime-archive.sqlite');
mkdirSync(dataDir, { recursive: true });
if (!existsSync(dbPath)) copyFileSync(seedPath, dbPath);
const db = new DatabaseSync(dbPath);

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
  CREATE TABLE IF NOT EXISTS metadata_shows (
    tvdb_show_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT,
    next_aired TEXT, last_synced_at TEXT NOT NULL,
    poster_url TEXT, backdrop_url TEXT, overview TEXT, first_aired TEXT, airs_time TEXT
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

function dotenv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/)
    .filter(line => line && !line.trimStart().startsWith('#') && line.includes('='))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
}

async function tvdbToken() {
  const env = dotenv();
  const apikey = env.THETVDB_API_KEY || env.API_KEY;
  if (!apikey) throw new Error('Add THETVDB_API_KEY to .env before syncing episode data');
  const response = await fetch('https://api4.thetvdb.com/v4/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apikey }) });
  const payload = await response.json();
  if (!response.ok || !payload.data?.token) throw new Error('TheTVDB login failed');
  return payload.data.token;
}

async function tvdbGet(url, token) {
  const response = await fetch(url.startsWith('http') ? url : `https://api4.thetvdb.com/v4${url}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  if (!response.ok || payload.status !== 'success') throw new Error(payload.message || `TheTVDB request failed (${response.status})`);
  return payload.data;
}

async function syncShow(show, token) {
  const series = await tvdbGet(`/series/${show.tvtime_show_id}/extended`, token);
  let pageUrl = `/series/${show.tvtime_show_id}/episodes/default?page=0`;
  const episodes = [];
  while (pageUrl) {
    const response = await fetch(pageUrl.startsWith('http') ? pageUrl : `https://api4.thetvdb.com/v4${pageUrl}`, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json();
    if (!response.ok || payload.status !== 'success') throw new Error(payload.message || `Episode request failed (${response.status})`);
    episodes.push(...(payload.data?.episodes || []));
    pageUrl = payload.links?.next || null;
  }
  const syncedAt = now();
  db.exec('BEGIN');
  try {
    const backdrop = (series.artworks || []).filter(artwork => artwork.type === 3).sort((a, b) => (b.score || 0) - (a.score || 0))[0]?.image || '';
    run(`INSERT INTO metadata_shows (tvdb_show_id, title, status, next_aired, last_synced_at, poster_url, backdrop_url, overview, first_aired, airs_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tvdb_show_id) DO UPDATE SET title=excluded.title, status=excluded.status, next_aired=excluded.next_aired, last_synced_at=excluded.last_synced_at, poster_url=excluded.poster_url, backdrop_url=excluded.backdrop_url, overview=excluded.overview, first_aired=excluded.first_aired, airs_time=excluded.airs_time`,
        String(show.tvtime_show_id), series.name || show.title, series.status?.name || '', series.nextAired || '', syncedAt, series.image || '', backdrop, series.overview || '', series.firstAired || '', series.airsTime || '');
    run('DELETE FROM episode_catalog WHERE tvdb_show_id=?', String(show.tvtime_show_id));
    const insert = db.prepare('INSERT INTO episode_catalog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const episode of episodes) insert.run(String(episode.id), String(show.tvtime_show_id), Number(episode.seasonNumber ?? 0), Number(episode.number ?? 0), episode.name || '', episode.overview || '', episode.aired || '', episode.runtime ?? null, Number(episode.seasonNumber) === 0 ? 1 : 0, String(episode.lastUpdated || ''), syncedAt);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return episodes.length;
}

async function syncFollowedShows() {
  const shows = rows(`SELECT show_key, tvtime_show_id, title FROM shows WHERE tvtime_show_id != ''`);
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
    shows: one(`SELECT COUNT(*) AS n FROM (SELECT show_key FROM shows UNION SELECT show_key FROM custom_shows)`).n,
    following: one(`SELECT COUNT(*) AS n FROM shows WHERE followed = '1' AND archived != '1'`).n + one(`SELECT COUNT(*) AS n FROM custom_shows WHERE followed = '1' AND archived != '1'`).n,
    episodes: one(`SELECT COUNT(*) AS n FROM episode_watches`).n,
    moviesWatched: one(`SELECT COUNT(DISTINCT title) AS n FROM movie_events WHERE event_type = 'watch'`).n,
    watchlistMovies: one(`SELECT COUNT(DISTINCT title) AS n FROM movie_events WHERE event_type IN ('towatch', 'watchlist')`).n + one(`SELECT COUNT(*) AS n FROM custom_movies WHERE status = 'watchlist'`).n,
  };
  const recent = rows(`
    SELECT w.show_title AS title, 'Episode' AS kind, w.season_number, w.episode_number, w.watched_at AS occurred_at, w.show_key, m.first_aired
    FROM episode_watches w LEFT JOIN shows s ON s.show_key=w.show_key LEFT JOIN metadata_shows m ON m.tvdb_show_id=s.tvtime_show_id
    UNION ALL
    SELECT title, 'Movie' AS kind, '', '', COALESCE(watch_date, event_at), NULL, NULL FROM movie_events WHERE event_type = 'watch'
    ORDER BY occurred_at DESC LIMIT 10
  `);
  const continueWatching = rows(`
    SELECT s.title, s.show_key, m.poster_url, m.first_aired, MAX(e.watched_at) AS last_watched,
           (SELECT 'S' || e2.season_number || 'E' || e2.episode_number FROM episode_watches e2 WHERE e2.show_key=s.show_key ORDER BY e2.watched_at DESC, e2.rowid DESC LIMIT 1) AS latest_episode
    FROM shows s JOIN episode_watches e ON e.show_key=s.show_key LEFT JOIN metadata_shows m ON m.tvdb_show_id=s.tvtime_show_id
    WHERE s.followed='1' AND s.archived != '1'
    GROUP BY s.show_key ORDER BY last_watched DESC LIMIT 8
  `);
  return { stats, recent, continueWatching };
}

function api(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/dashboard') return json(res, 200, dashboard());
  if (req.method === 'GET' && path === '/api/shows') {
    const q = (url.searchParams.get('q') || '').trim();
    const filter = `%${q}%`;
    return json(res, 200, rows(`
      SELECT library.*, m.poster_url, m.backdrop_url, m.next_aired, m.status, m.first_aired, (SELECT COUNT(*) FROM episode_watches e WHERE e.show_key = library.show_key) AS logged_episodes,
      (SELECT COUNT(*) FROM episode_catalog e WHERE e.tvdb_show_id=library.tvtime_show_id AND e.is_special=0 AND e.aired_at != '' AND date(e.aired_at) <= date('now')) AS available_episodes,
      (SELECT COUNT(DISTINCT w.episode_tvtime_id) FROM episode_watches w JOIN episode_catalog e ON e.tvdb_episode_id=w.episode_tvtime_id WHERE e.tvdb_show_id=library.tvtime_show_id AND e.is_special=0 AND e.aired_at != '' AND date(e.aired_at) <= date('now')) AS catalog_watched_episodes,
      (SELECT MAX(watched_at) FROM episode_watches e WHERE e.show_key = library.show_key) AS last_watched
      FROM (
        SELECT show_key, tvtime_show_id, title, followed, favorited, archived, episodes_seen_reported, followed_at, updated_at FROM shows
        UNION ALL
        SELECT show_key, tvtime_show_id, title, followed, favorited, archived, episodes_seen_reported, followed_at, updated_at FROM custom_shows
      ) library LEFT JOIN metadata_shows m ON m.tvdb_show_id=library.tvtime_show_id
      WHERE library.title LIKE ? ORDER BY library.archived, library.followed DESC, library.title COLLATE NOCASE`, filter));
  }
  if (req.method === 'GET' && path === '/api/movies') {
    return json(res, 200, rows(`
      SELECT title, MAX(CASE WHEN event_type='watch' THEN 1 ELSE 0 END) AS watched,
             MAX(CASE WHEN event_type IN ('towatch','watchlist') THEN 1 ELSE 0 END) AS watchlist,
             MAX(event_at) AS last_activity
      FROM movie_events GROUP BY title
      UNION ALL SELECT title, status='watched', status='watchlist', updated_at FROM custom_movies
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
      SELECT e.tvdb_episode_id, e.tvdb_show_id, s.title AS show_title, m.poster_url, e.season_number, e.episode_number, e.title, e.aired_at, e.runtime,
             EXISTS(SELECT 1 FROM episode_watches w WHERE w.episode_tvtime_id=e.tvdb_episode_id) AS watched
      FROM episode_catalog e JOIN shows s ON s.tvtime_show_id=e.tvdb_show_id LEFT JOIN metadata_shows m ON m.tvdb_show_id=e.tvdb_show_id
      WHERE s.followed='1' AND s.archived != '1' AND e.is_special=0 AND date(e.aired_at) >= date('now') AND date(e.aired_at) < date('now', '+3 months')
      ORDER BY e.aired_at, s.title, e.season_number, e.episode_number LIMIT 100`));
  }
  if (req.method === 'GET' && /^\/api\/shows\/[^/]+\/episodes$/.test(path)) {
    const key = decodeURIComponent(path.slice('/api/shows/'.length, -'/episodes'.length));
    const show = one(`SELECT show_key, tvtime_show_id, title, followed, archived FROM shows WHERE show_key=? UNION ALL SELECT show_key, tvtime_show_id, title, followed, archived FROM custom_shows WHERE show_key=?`, key, key);
    if (!show) return json(res, 404, { error: 'Show not found' });
    const metadata = one('SELECT * FROM metadata_shows WHERE tvdb_show_id=?', show.tvtime_show_id) || null;
    const episodes = rows(`SELECT e.*, (SELECT COUNT(*) FROM episode_watches w WHERE w.episode_tvtime_id=e.tvdb_episode_id) AS watch_count
      FROM episode_catalog e WHERE e.tvdb_show_id=? ORDER BY e.season_number, e.episode_number`, show.tvtime_show_id);
    return json(res, 200, { show, metadata, episodes });
  }
  if (req.method === 'POST' && path === '/api/sync/shows') return syncFollowedShows().then(result => json(res, 200, result));
  if (req.method === 'POST' && path === '/api/shows') return body(req).then(input => {
    const title = cleanText(input.title, 'Show title'); const key = `local:${crypto.randomUUID()}`; const timestamp = now();
    run('INSERT INTO custom_shows (show_key, tvtime_show_id, title, followed, favorited, archived, episodes_seen_reported, followed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', key, '', title, '1', '0', '0', '0', timestamp, timestamp);
    json(res, 201, { show_key: key });
  });
  if (req.method === 'PATCH' && path.startsWith('/api/shows/')) return body(req).then(input => {
    const key = decodeURIComponent(path.slice('/api/shows/'.length));
    if (!['followed', 'favorited', 'archived'].includes(input.field)) throw new Error('Unsupported show field');
    const value = input.value ? '1' : '0';
    const inSeed = one('SELECT show_key FROM shows WHERE show_key=?', key);
    run(`UPDATE ${inSeed ? 'shows' : 'custom_shows'} SET ${input.field}=?, updated_at=? WHERE show_key=?`, value, now(), key);
    json(res, 200, { ok: true });
  });
  if (req.method === 'POST' && path === '/api/episodes/watch') return body(req).then(input => {
    const showKey = cleanText(input.show_key, 'Show'); const season = Number(input.season); const episode = Number(input.episode);
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) throw new Error('Season and episode must be valid numbers');
    const show = one(`SELECT title FROM shows WHERE show_key=? UNION ALL SELECT title FROM custom_shows WHERE show_key=?`, showKey, showKey);
    if (!show) throw new Error('Show not found');
    run('INSERT INTO episode_watches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', `local-${crypto.randomUUID()}`, '', showKey, show.title, String(season), String(episode), now(), now(), input.rewatch ? 'rewatch' : 'watch', 'manual');
    json(res, 201, { ok: true });
  });
  if (req.method === 'POST' && /^\/api\/episodes\/[^/]+\/watch$/.test(path)) return body(req).then(input => {
    const episodeId = decodeURIComponent(path.slice('/api/episodes/'.length, -'/watch'.length));
    const episode = one(`SELECT e.tvdb_episode_id, e.tvdb_show_id, e.season_number, e.episode_number, m.title AS show_title
      FROM episode_catalog e JOIN metadata_shows m ON m.tvdb_show_id=e.tvdb_show_id WHERE e.tvdb_episode_id=?`, episodeId);
    if (!episode) throw new Error('Episode not found in the local guide');
    const show = one(`SELECT show_key FROM shows WHERE tvtime_show_id=? UNION ALL SELECT show_key FROM custom_shows WHERE tvtime_show_id=?`, episode.tvdb_show_id, episode.tvdb_show_id);
    if (!show) throw new Error('This episode is not linked to a show in your library');
    const kind = input.rewatch ? 'rewatch' : 'watch';
    run('INSERT INTO episode_watches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', `local-${crypto.randomUUID()}`, episode.tvdb_episode_id, show.show_key, episode.show_title, String(episode.season_number), String(episode.episode_number), now(), now(), kind, 'manual');
    json(res, 201, { ok: true, watch_count: one('SELECT COUNT(*) AS n FROM episode_watches WHERE episode_tvtime_id=?', episodeId).n });
  });
  if (req.method === 'POST' && path === '/api/movies') return body(req).then(input => {
    const title = cleanText(input.title, 'Movie title'); const status = input.status === 'watched' ? 'watched' : 'watchlist'; const timestamp = now();
    run('INSERT INTO custom_movies VALUES (?, ?, ?, ?, ?) ON CONFLICT(title) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at', title, status, input.rating_code || '', timestamp, timestamp);
    if (status === 'watched') run('INSERT INTO movie_events VALUES (?, ?, ?, ?, ?, ?, ?)', title, 'watch', `local-${crypto.randomUUID()}`, timestamp, timestamp, timestamp, '');
    json(res, 201, { ok: true });
  });
  return json(res, 404, { error: 'Not found' });
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(root, 'public', requested));
    if (!file.startsWith(join(root, 'public')) || !existsSync(file)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    res.end(await import('node:fs/promises').then(fs => fs.readFile(file)));
  } catch (error) { json(res, 400, { error: error.message || 'Request failed' }); }
}).listen(port, () => console.log(`ReelTime is running at http://localhost:${port}`));
