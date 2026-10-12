import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';

async function setup(t) { const f=await fixture(); t.after(()=>f.close()); return f; }
function local(f,key,title='Pantheon') { f.db.prepare('INSERT INTO custom_shows (show_key,title) VALUES (?,?)').run(key,title); }
async function post(f,key,action,input={}) {return f.request(`/api/shows/${encodeURIComponent(key)}/${action}`,input);}

test('removal requires exact title and targets one duplicate entry; cancellation makes no change', async t => {
  const f=await setup(t); local(f,'local:first'); local(f,'local:second');
  for (const input of [{},{confirm_title:'pantheon'},{confirm_title:'Pantheon '},{confirm_title:true}]) assert.equal((await post(f,'local:first','remove',input)).status,400);
  assert.equal((await f.request('/api/shows')).data.length,2);
  assert.equal((await post(f,'local:missing','remove',{confirm_title:'Pantheon'})).status,404);
  assert.equal((await post(f,'local:first','remove',{confirm_title:'Pantheon'})).status,200);
  assert.deepEqual((await f.request('/api/shows')).data.map(s=>s.show_key),['local:second']);
  assert.equal((await f.request('/api/shows/local%3Afirst/episodes')).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n,2);
  assert.equal((await f.request('/api/shows/removed')).data[0].show_key,'local:first');
  assert.equal((await post(f,'local:first','remove',{confirm_title:'Pantheon'})).status,200);
  assert.equal((await f.request('/api/shows/removed')).data.length,1);
});
test('removal excludes stats, queue, upcoming, sync and new watch writes but preserves history and cache', async t => {
  const f=await setup(t); await f.request('/api/shows',{provider_id:'1'}); await f.request('/api/episodes/100/watch',{});
  assert.equal((await f.request('/api/upcoming')).data[0].show_key,'tvdb:1');
  assert.equal((await f.request('/api/dashboard')).data.continueWatching.length,1);
  await post(f,'tvdb:1','remove',{confirm_title:'Bear'});
  const dashboard=(await f.request('/api/dashboard')).data;
  assert.equal(dashboard.stats.shows,0); assert.equal(dashboard.stats.following,0); assert.equal(dashboard.stats.episodes,1); assert.equal(dashboard.continueWatching.length,0); assert.equal(dashboard.recent[0].show_key,null);
  assert.equal((await f.request('/api/upcoming')).data.length,0); assert.equal((await f.request('/api/shows')).data.length,0);
  assert.equal((await f.request('/api/history')).data.length,1);
  f.state.calls=[]; assert.equal((await f.request('/api/sync/shows',{})).data.synced,0);
  assert.equal(f.state.calls.some(c=>c.includes('/series/')),false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM episode_catalog').get().n,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM season_catalog').get().n,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM metadata_shows').get().n,1);
  assert.equal((await f.request('/api/episodes/100/watch',{})).status,400);
  assert.equal((await f.request('/api/episodes/watch',{show_key:'tvdb:1',season:1,episode:1})).status,400);
  assert.equal((await f.request('/api/shows/removed')).data[0].watch_count,1);
});
test('restore preserves imported flags, watch history, cached progress and identity with persisted removal', async t => {
  const f=await setup(t);
  f.db.exec("INSERT INTO shows VALUES ('tvtime:1','1','Imported','0','1','1','9','','')");
  await f.request('/api/shows',{provider_id:'1'}); await f.request('/api/episodes/100/watch',{});
  const before=f.db.prepare('SELECT * FROM shows').get();
  await post(f,'tvtime:1','remove',{confirm_title:'Imported'});
  const saved = new DatabaseSync(join(f.dir,'fixture.sqlite'), {readOnly:true});
  assert.equal(saved.prepare('SELECT show_key FROM removed_shows').get().show_key,'tvtime:1');
  saved.close();
  assert.equal((await post(f,'tvtime:1','restore')).status,200);
  assert.deepEqual(f.db.prepare('SELECT * FROM shows').get(),before);
  const detail=(await f.request('/api/shows/tvtime%3A1/episodes')).data;
  assert.equal(detail.episodes.find(e=>e.tvdb_episode_id==='100').watch_count,1);
  assert.equal((await f.request('/api/shows/removed')).data.length,0);
  assert.equal((await post(f,'tvtime:1','restore')).status,200);
  assert.equal((await post(f,'missing','restore')).status,404);
});
test('provider re-add restores its removed identity without duplicating it or discarding history', async t => {
  const f=await setup(t); await f.request('/api/shows',{provider_id:'1'}); await f.request('/api/episodes/100/watch',{});
  await post(f,'tvdb:1','remove',{confirm_title:'Bear'});
  const result=await f.request('/api/shows',{provider_id:'1'});
  assert.equal(result.data.show_key,'tvdb:1'); assert.equal(result.data.existing,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n,1);
  assert.equal((await f.request('/api/shows')).data.length,1);
  assert.equal((await f.request('/api/history')).data.length,1);
});
test('database failure leaves membership intact and can be retried', async t => {
  const f=await setup(t); local(f,'local:one');
  f.db.exec("CREATE TRIGGER fail_remove BEFORE INSERT ON removed_shows BEGIN SELECT RAISE(ABORT,'fixture removal failure'); END;");
  assert.equal((await post(f,'local:one','remove',{confirm_title:'Pantheon'})).status,400);
  assert.equal((await f.request('/api/shows')).data.length,1);
  f.db.exec('DROP TRIGGER fail_remove'); await post(f,'local:one','remove',{confirm_title:'Pantheon'});
  f.db.exec("CREATE TRIGGER fail_restore BEFORE DELETE ON removed_shows BEGIN SELECT RAISE(ABORT,'fixture restore failure'); END;");
  assert.equal((await post(f,'local:one','restore')).status,400);
  assert.equal((await f.request('/api/shows')).data.length,0);
  f.db.exec('DROP TRIGGER fail_restore'); assert.equal((await post(f,'local:one','restore')).status,200);
});
