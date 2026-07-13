import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
`);
// Databases created by the first development build did not have this nullable
// column. Keep the local database forward-compatible without touching imports.
if (!db.prepare('PRAGMA table_info(custom_shows)').all().some(column => column.name === 'tvtime_show_id')) {
  db.exec('ALTER TABLE custom_shows ADD COLUMN tvtime_show_id TEXT');
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const rows = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

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
    SELECT show_title AS title, 'Episode' AS kind, season_number, episode_number, watched_at AS occurred_at
    FROM episode_watches
    UNION ALL
    SELECT title, 'Movie' AS kind, '', '', COALESCE(watch_date, event_at) FROM movie_events WHERE event_type = 'watch'
    ORDER BY occurred_at DESC LIMIT 10
  `);
  const continueWatching = rows(`
    SELECT s.title, s.show_key, MAX(e.watched_at) AS last_watched,
           (SELECT 'S' || e2.season_number || 'E' || e2.episode_number FROM episode_watches e2 WHERE e2.show_key=s.show_key ORDER BY e2.watched_at DESC, e2.rowid DESC LIMIT 1) AS latest_episode
    FROM shows s JOIN episode_watches e ON e.show_key=s.show_key
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
      SELECT *, (SELECT COUNT(*) FROM episode_watches e WHERE e.show_key = library.show_key) AS logged_episodes,
      (SELECT MAX(watched_at) FROM episode_watches e WHERE e.show_key = library.show_key) AS last_watched
      FROM (
        SELECT show_key, tvtime_show_id, title, followed, favorited, archived, episodes_seen_reported, followed_at, updated_at FROM shows
        UNION ALL
        SELECT show_key, tvtime_show_id, title, followed, favorited, archived, episodes_seen_reported, followed_at, updated_at FROM custom_shows
      ) library
      WHERE title LIKE ? ORDER BY archived, followed DESC, title COLLATE NOCASE`, filter));
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
