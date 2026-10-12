import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './fixtures.mjs';
async function setup(t){const f=await fixture();t.after(()=>f.close());return f;}
const add=(f,id='10',status='watchlist')=>f.request('/api/movies',{provider_id:id,status});

test('movie-only top-three ranked previews distinguish remakes and require no writes',async t=>{
 const f=await setup(t);const r=await f.request('/api/movies/search?q=Dune');
 assert.equal(r.status,200);assert.deepEqual(r.data.map(m=>m.provider_id),['11','10','12']);
 assert.equal(r.data[1].year,'2021');assert.equal(r.data[1].director,'Denis Villeneuve');assert.equal(r.data[0].runtime,155);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);
 assert.equal((await f.request('/api/movies',{title:'Dune',status:'watched'})).status,400);
 assert.equal((await f.request('/api/movies',{provider_id:'10',status:'invalid'})).status,400);
});
test('missing details and artwork use unknowns; empty and failed movie searches are distinct',async t=>{
 const f=await setup(t);f.state.missingMovieDetails=true;
 let r=await f.request('/api/movies/search?q=Dune');assert.equal(r.data[0].runtime,null);assert.equal(r.data[0].poster_url,'');
 f.state.failMovie=true;r=await f.request('/api/movies/search?q=Dune');assert.match(r.data[0].details_error,/unavailable/);
 f.state.movieResults=[];assert.deepEqual((await f.request('/api/movies/search?q=none')).data,[]);
 f.state.failSearch=true;assert.equal((await f.request('/api/movies/search?q=Dune')).status,400);
});
test('watchlist confirmation saves metadata; upgrade to watched logs once; repeats never downgrade',async t=>{
 const f=await setup(t);assert.equal((await add(f)).status,201);
 let list=(await f.request('/api/movies')).data;assert.equal(list.length,1);assert.equal(list[0].movie_key,'tvdb-movie:10');assert.equal(list[0].year,'2021');assert.equal(list[0].runtime,155);assert.equal(list[0].overview,'A desert epic.');
 assert.equal((await f.request('/api/history')).data.length,0);assert.equal((await f.request('/api/dashboard')).data.stats.watchlistMovies,1);
 const results=await Promise.all([add(f,'10','watched'),add(f,'10','watched')]);assert.ok(results.every(r=>r.data.existing));
 await add(f,'10','watchlist');list=(await f.request('/api/movies')).data;assert.equal(list.length,1);assert.equal(list[0].watched,1);assert.equal(list[0].watchlist,0);
 assert.equal((await f.request('/api/history')).data.length,1);assert.equal((await f.request('/api/dashboard')).data.stats.moviesWatched,1);
});
test('same-title provider identities stay distinct and legacy records are preserved',async t=>{
 const f=await setup(t);f.db.exec("INSERT INTO custom_movies VALUES ('Dune','watchlist','','old','old'); INSERT INTO movie_events (title,event_type,event_key,event_at,updated_at,watch_date,rewatch_count) VALUES ('Dune','watch','imported','old','old','old','')");
 await Promise.all([add(f,'10','watched'),add(f,'11','watched')]);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_movies').get().n,1);
 assert.equal(f.db.prepare("SELECT movie_key FROM movie_events WHERE event_key='imported'").get().movie_key,null);
 const list=(await f.request('/api/movies')).data;assert.equal(list.filter(m=>m.movie_key).length,2);
 assert.equal((await f.request('/api/dashboard')).data.stats.moviesWatched,3);
});
test('provider and transactional write failures preserve history and allow retry',async t=>{
 const f=await setup(t);f.state.failMovie=true;assert.equal((await add(f,'10','watched')).status,400);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);
 f.state.failMovie=false;f.db.exec("CREATE TRIGGER fail_watch BEFORE INSERT ON movie_events BEGIN SELECT RAISE(ABORT,'fixture movie write failed'); END;");
 assert.equal((await add(f,'10','watched')).status,400);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);
 f.db.exec('DROP TRIGGER fail_watch');assert.equal((await add(f,'10','watched')).status,201);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n,1);
});
