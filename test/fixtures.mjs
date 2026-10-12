import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

export async function fixture({movieSourcePath = null} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reeltime-test-'));
  const db = new DatabaseSync(join(dir, 'fixture.sqlite'));
  db.exec(`CREATE TABLE shows (show_key TEXT PRIMARY KEY, tvtime_show_id TEXT, title TEXT, followed TEXT, favorited TEXT, archived TEXT, episodes_seen_reported TEXT, followed_at TEXT, updated_at TEXT);
    CREATE TABLE episode_watches (source_key TEXT, episode_tvtime_id TEXT, show_key TEXT, show_title TEXT, season_number TEXT, episode_number TEXT, watched_at TEXT, updated_at TEXT, event_kind TEXT, bulk_type TEXT);
    CREATE TABLE movie_events (title TEXT, event_type TEXT, event_key TEXT, event_at TEXT, updated_at TEXT, watch_date TEXT, rewatch_count TEXT);`);
  const state = { failSearch: false, failPage: false, failSeries: false, empty: false, malformed: false, failMovie: false, missingMovieDetails: false, movieResults: [
    {tvdb_id:'12',type:'movie',name:'Dune: Part Two',year:'2024'},
    {tvdb_id:'11',type:'movie',name:'Dune',year:'1984',country:'usa'},
    {tvdb_id:'10',type:'movie',name:'Dune',year:'2021',country:'usa',director:'Denis Villeneuve',image_url:'/missing-movie.jpg',overview:'A young heir visits a desert world.'},
    {tvdb_id:'14',type:'series',name:'Dune',year:'2000'},
    {tvdb_id:'13',type:'movie',name:'Unrelated film'},
  ], calls: [], results: [
    { tvdb_id: '2', name: 'Bear Country', year: '1990', country: 'usa' },
    { tvdb_id: '3', name: 'The Bear', year: '1980', country: 'gbr' },
    { tvdb_id: '1', name: 'Bear', year: '2022', country: 'usa', network: 'FX', image_url: '/missing-poster.jpg', overview: 'A cook returns home.' },
    { tvdb_id: '4', name: 'Unrelated' },
  ] };
  const provider = async url => {
    const u = new URL(url); state.calls.push(u.pathname + u.search);
    const reply = (data, ok = true, extra = {}) => ({ ok, status: ok ? 200 : 503, json: async () => ({status: ok ? 'success' : 'failure', data, message: ok ? undefined : 'Provider temporarily unavailable', ...extra}) });
    if (u.pathname.endsWith('/login')) return reply({token: 'fixture-token'});
    if (u.pathname.endsWith('/search')) return reply(u.searchParams.get('type') === 'movie' ? state.movieResults : state.results, !state.failSearch);
    if (u.pathname.includes('/movies/')) {
      const id=u.pathname.split('/')[3]; const match=state.movieResults.find(r=>r.tvdb_id===id);
      return reply({id:Number(id),name:match?.name || 'Dune',year:match?.year || '', originalCountry:match?.country || '',image:state.missingMovieDetails ? '' : '/missing-movie.jpg',runtime:state.missingMovieDetails ? null : 155,translations:{overviewTranslations:[{language:'eng',overview:'A desert epic.'}]},studios:[]},!state.failMovie);
    }
    const id = u.pathname.split('/')[3];
    if (u.pathname.endsWith('/extended')) return reply({id: Number(id), name: state.results.find(r => r.tvdb_id === id)?.name || 'Bear', firstAired: '2022-01-01', defaultSeasonType: 1, seasons: [{id: 501, number: 1, type: {id: 1}, name: 'First season'}, {id: 502, number: 2, type: {id: 1}}, {id: 599, number: 9, type: {id: 2}}]}, !state.failSeries);
    const page = u.searchParams.get('page');
    if (state.malformed) return reply({});
    if (state.empty) return reply({episodes: []});
    if (page === '0') return reply({episodes: [{id: Number(id) * 100, seasonNumber: 1, number: 1, name: 'Pilot', aired: '2022-01-01'}]}, true, {links: {next: `/v4/series/${id}/episodes/default?page=1`}});
    return reply({episodes: [{id: Number(id) * 100 + 1, seasonNumber: 2, number: 1, name: 'Return', aired: new Date().toISOString().slice(0,10)}, {id: Number(id) * 100 + 2, seasonNumber: 0, number: 1, name: 'Special'}]}, !state.failPage);
  };
  const server = createApp({db, movieSourcePath, fetch: provider, config: () => ({THETVDB_API_KEY: 'fixture-key'})});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {db, state, url, dir, async request(path, input) {
    const response = await fetch(url + path, input === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)});
    return {status: response.status, data: await response.json()};
  }, async close() { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, {recursive: true, force: true}); } };
}
