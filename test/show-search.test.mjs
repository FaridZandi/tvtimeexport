import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fixture } from './fixtures.mjs';

async function setup(t) { const f = await fixture(); t.after(async () => { await f.close(); assert.equal(existsSync(f.dir), false); }); return f; }
test('search ranks best three identities and counts complete default guide excluding specials', async t => {
  const f = await setup(t);
  const r = await f.request('/api/shows/search?q=Bear');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map(r => r.provider_id), ['1','2','3']);
  assert.equal(r.data[0].season_count, 2); assert.equal(r.data[0].episode_count, 2);
  assert.equal(r.data[1].poster_url, ''); assert.equal(r.data[2].country, 'gbr');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 0);
});
test('failed preview counts remain unknown; no results and provider errors are distinct', async t => {
  const f = await setup(t); f.state.failPage = true;
  const r = await f.request('/api/shows/search?q=Bear');
  assert.equal(r.data[0].season_count, null); assert.equal(r.data[0].episode_count, null);
  assert.match(r.data[0].count_error, /unavailable/);
  f.state.results = []; assert.deepEqual((await f.request('/api/shows/search?q=none')).data, []);
  f.state.failSearch = true; assert.match((await f.request('/api/shows/search?q=Bear')).data.error, /unavailable/);
});
test('confirmation syncs automatically and repeated or concurrent selections reuse one provider identity', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/api/shows', {title:'Bare name'})).status, 400);
  const results = await Promise.all([f.request('/api/shows', {provider_id:'1'}), f.request('/api/shows', {provider_id:'1'})]);
  assert.equal(results[0].data.show_key, results[1].data.show_key);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 1);
  assert.equal((await f.request('/api/shows', {provider_id:'1'})).data.existing, true);
  const detail = (await f.request('/api/shows/tvdb%3A1/episodes')).data;
  assert.equal(detail.show.tvtime_show_id, '1'); assert.equal(detail.metadata.title, 'Bear'); assert.equal(detail.episodes.length, 3);
  assert.deepEqual(detail.seasons.map(s => s.season_number), [0,1,2]);
  assert.equal(detail.seasons[1].tvdb_season_id, '501');
  assert.equal((await f.request('/api/upcoming')).data.length, 1);
  assert.equal((await f.request('/api/episodes/100/watch', {})).status, 201);
});
test('partial episode failure and retry do not leave an empty show', async t => {
  const f = await setup(t); f.state.failPage = true;
  assert.equal((await f.request('/api/shows', {provider_id:'1'})).status, 400);
  for (const table of ['custom_shows','metadata_shows','season_catalog','episode_catalog']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  f.state.failPage = false; assert.equal((await f.request('/api/shows', {provider_id:'1'})).status, 201);
});
test('failed refresh preserves existing guide and watches; retry includes new provider-linked shows', async t => {
  const f = await setup(t); await f.request('/api/shows', {provider_id:'1'}); await f.request('/api/episodes/100/watch', {});
  f.state.failPage = true;
  assert.equal((await f.request('/api/sync/shows', {})).data.failures.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM episode_catalog').get().n, 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM episode_watches').get().n, 1);
  f.state.failPage = false; assert.equal((await f.request('/api/sync/shows', {})).data.synced, 1);
});
test('series failure, malformed guide and genuinely empty guide leave library unchanged', async t => {
  const f = await setup(t);
  for (const flag of ['failSeries','malformed','empty']) {
    f.state[flag] = true;
    assert.equal((await f.request('/api/shows', {provider_id:'1'})).status, 400);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 0);
    f.state[flag] = false;
  }
});
test('imported identity is reused without changing flags or history', async t => {
  const f = await setup(t);
  f.db.exec("INSERT INTO shows VALUES ('tvtime:1','1','Imported Bear','0','1','1','12','','')");
  const r = await f.request('/api/shows', {provider_id:'1'});
  assert.equal(r.data.show_key, 'tvtime:1'); assert.equal(r.data.existing, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 0);
  assert.equal(f.db.prepare('SELECT archived FROM shows').get().archived, '1');
});
test('database write failure rolls back identity and metadata atomically', async t => {
  const f = await setup(t);
  f.db.exec("CREATE TRIGGER fail_catalog BEFORE INSERT ON episode_catalog BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END;");
  assert.match((await f.request('/api/shows', {provider_id:'1'})).data.error, /fixture write failed/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM metadata_shows').get().n, 0);
  f.db.exec('DROP TRIGGER fail_catalog'); assert.equal((await f.request('/api/shows', {provider_id:'1'})).status, 201);
});
