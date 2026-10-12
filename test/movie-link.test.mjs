import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixtures.mjs';
import { readMovieHints, parseCSV } from '../legacy-movies.mjs';
async function setup(t, options){const f=await fixture(options);t.after(()=>f.close());return f;}
function old(f,title='Dune'){
 f.db.prepare("INSERT INTO movie_events (title,event_type,event_key,event_at,updated_at,watch_date,rewatch_count) VALUES (?,'watch',?,'2000-01-02','2000-01-03','1999-12-31','3')").run(title,`watch-${title}`);
 f.db.prepare("INSERT INTO movie_events (title,event_type,event_key,event_at,updated_at,watch_date,rewatch_count) VALUES (?,'watchlist',?,'2000-01-04','2000-01-05','','')").run(title,`list-${title}`);
 f.db.prepare("INSERT INTO custom_movies VALUES (?,'watchlist','5','2000-01-01','2000-01-06')").run(title);
}
const link=(f,id='10',expected=null,title='Dune')=>f.request('/api/movies/link',{legacy_title:title,provider_id:id,expected_provider_id:expected});
const unlink=(f,id='10',title='Dune')=>f.request('/api/movies/unlink',{legacy_title:title,expected_provider_id:id});
test('CSV hints handle quoted commas/newlines/BOM, conflicting years and missing/invalid dates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reeltime-hints-'));try{
 const path=join(dir,'source.csv');writeFileSync(path,'\uFEFFmovie_name,release_date\r\nDune,2021-01-01\r\nDune,1984-01-01\r\n"Comma, \"\"film\"\"",2001-01-01\r\n"Multi\nline",2002-01-01\r\nUnknown,bad\r\n');
 const hints=readMovieHints(path);assert.deepEqual(hints.get('Dune'),['1984','2021']);assert.deepEqual(hints.get('Comma, "film"'),['2001']);assert.deepEqual(hints.get('Multi\nline'),['2002']);assert.equal(hints.has('Unknown'),false);
 assert.equal(readMovieHints(null).size,0);assert.throws(()=>parseCSV('title\n"unfinished'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('source year prefers a remake, cached bulk suggestions remain unconfirmed and refresh retries failures',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'reeltime-hints-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'source.csv');writeFileSync(path,'movie_name,release_date\nDune,2021-01-01\n');
 const f=await setup(t,{movieSourcePath:path});old(f);
 let r=await f.request('/api/movies/link-suggestions?title=Dune');assert.equal(r.data.matches[0].provider_id,'10');assert.equal(r.data.matches.length,3);assert.deepEqual(r.data.source_years,['2021']);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_movie_links').get().n,0);
 f.state.calls=[];await f.request('/api/movies/link-suggestions?title=Dune');assert.equal(f.state.calls.length,0);
 f.state.failSearch=true;assert.equal((await f.request('/api/movies/link-suggestions?title=Dune&refresh=1')).status,400);assert.match((await f.request('/api/movies/legacy')).data[0].suggestions_error,/unavailable/);
 f.state.failSearch=false;assert.equal((await f.request('/api/movies/link-suggestions?title=Dune')).status,200);
});
test('link preserves every original event/custom field and status; change and undo restore title-only library',async t=>{
 const f=await setup(t);old(f);const events=f.db.prepare('SELECT * FROM movie_events ORDER BY event_key').all();const custom=f.db.prepare('SELECT * FROM custom_movies').all();
 assert.equal((await link(f)).status,200);let list=(await f.request('/api/movies')).data;assert.equal(list.length,1);assert.equal(list[0].tvdb_movie_id,'10');assert.equal(list[0].watched,1);assert.equal(list[0].watchlist,1);
 assert.equal((await link(f,'11','10')).status,200);assert.equal((await f.request('/api/movies')).data[0].year,'1984');
 assert.equal((await unlink(f,'11')).status,200);list=(await f.request('/api/movies')).data;assert.equal(list.length,1);assert.equal(list[0].movie_key,null);
 assert.deepEqual(f.db.prepare('SELECT * FROM movie_events ORDER BY event_key').all(),events);assert.deepEqual(f.db.prepare('SELECT * FROM custom_movies').all(),custom);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);
});
test('explicit link merges existing provider card and counts; undo separates untouched histories',async t=>{
 const f=await setup(t);old(f);await f.request('/api/movies',{provider_id:'10',status:'watched'});
 const eventCount=f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n;
 assert.equal((await f.request('/api/movies')).data.length,2);
 await link(f);assert.equal((await f.request('/api/movies')).data.length,1);assert.equal((await f.request('/api/dashboard')).data.stats.moviesWatched,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n,eventCount);
 await unlink(f);assert.equal((await f.request('/api/movies')).data.length,2);assert.equal((await f.request('/api/history')).data.length,eventCount);
});
test('re-adding a linked identity does not create an independent movie or watch event',async t=>{
 const f=await setup(t);old(f);await link(f);const n=f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n;
 const r=await f.request('/api/movies',{provider_id:'10',status:'watched'});assert.equal(r.data.existing,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n,n);
 await unlink(f);assert.equal((await f.request('/api/movies')).data.length,1);
});
test('invalid targets, provider failure, stale confirmation/undo and database failure preserve prior link',async t=>{
 const f=await setup(t);old(f);assert.equal((await link(f,'10',null,'Missing')).status,400);
 assert.equal((await f.request('/api/movies/link',{legacy_title:'Dune',provider_id:'bad',expected_provider_id:null})).status,400);
 await link(f);assert.equal((await link(f,'11',null)).status,400);assert.equal((await unlink(f,'11')).status,400);
 f.state.failMovie=true;assert.equal((await link(f,'11','10')).status,400);f.state.failMovie=false;
 f.db.exec("CREATE TRIGGER fail_link BEFORE UPDATE ON legacy_movie_links BEGIN SELECT RAISE(ABORT,'fixture link failure'); END;");assert.equal((await link(f,'11','10')).status,400);
 assert.equal((await f.request('/api/movies/legacy')).data[0].linked_provider_id,'10');f.db.exec('DROP TRIGGER fail_link');
 assert.equal((await link(f,'11','10')).status,200);assert.equal((await unlink(f,'10')).status,400);
});
test('concurrent/repeated identical links are idempotent and never add watches',async t=>{
 const f=await setup(t);old(f);const results=await Promise.all([link(f),link(f)]);assert.ok(results.every(r=>r.status===200));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_movie_links').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n,2);
});
