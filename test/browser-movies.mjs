import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fixture } from './fixtures.mjs';
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail('Timed out waiting for browser state');}
async function setup(t,viewport={width:1280,height:900}){const f=await fixture();t.after(()=>f.close());const b=await chromium.launch({headless:true});t.after(()=>b.close());const p=await b.newPage({viewport});await p.route('https://**',r=>r.abort());await p.goto(f.url+'/#movies');return {...f,p};}
async function search(p){await p.locator('#providerQuery').fill('Dune');await until(async()=>await p.locator('.show-match').count()===3);}

test('Movies Add movie: three previews, explicit keyboard confirmation, watched status and populated card',async t=>{
 const f=await setup(t);const p=f.p;await p.getByText('＋ Add movie',{exact:true}).click();await search(p);
 assert.match(await p.locator('.show-match').nth(1).innerText(),/2021[\s\S]*Denis Villeneuve[\s\S]*155 min/);
 assert.equal(await p.locator('#confirmShow').isEnabled(),false);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);
 await p.locator('.show-match').nth(1).focus();await p.keyboard.press('Enter');await p.locator('#movieStatus').selectOption('watched');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);
 await p.screenshot({path:join(tmpdir(),'REEL-008-movies-desktop.png')});
 let release;const held=new Promise(r=>release=r);await p.route('**/api/movies',async route=>{if(route.request().method()==='POST')await held;await route.continue();});
 await p.locator('#confirmShow').focus();await p.keyboard.press('Enter');await until(async()=>(await p.locator('#searchStatus').innerText()).includes('Loading movie details'));
 assert.equal(await p.locator('#movieStatus').isEnabled(),false);release();await until(async()=>await p.locator('.movie-card').count()===1);
 assert.match(await p.locator('.movie-card').innerText(),/Dune[\s\S]*2021[\s\S]*155 min[\s\S]*Watched/);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n,1);
});
test('global Add → Movie at 390px: unknown details, no results, search/add errors with retry and watchlist status',async t=>{
 const f=await setup(t,{width:390,height:844});const p=f.p;await p.locator('#addButton').click();await p.locator('#movieTab').click();
 f.state.movieResults=[];await p.locator('#providerQuery').fill('none');await until(async()=>(await p.locator('#searchStatus').innerText()).includes('No movies found'));
 f.state.movieResults=[{tvdb_id:'10',type:'movie',name:'Dune',year:'2021'}];f.state.failSearch=true;
 await p.locator('#providerQuery').fill('Dune');await until(async()=>await p.locator('#retrySearch').isVisible());
 f.state.failSearch=false;f.state.missingMovieDetails=true;await p.locator('#retrySearch').click();await until(async()=>await p.locator('.show-match').count()===1);
 assert.match(await p.locator('.show-match').innerText(),/Runtime unknown/);assert.equal(await p.locator('[aria-label="No artwork"]').count(),1);
 await p.locator('.show-match').click();assert.equal(await p.evaluate(()=>document.querySelector('#dialog').scrollWidth<=document.querySelector('#dialog').clientWidth),true);
 await p.screenshot({path:join(tmpdir(),'REEL-008-movies-mobile.png')});
 f.state.failMovie=true;await p.locator('#confirmShow').click();await until(async()=>(await p.locator('#confirmShow').innerText()).includes('Retry add movie'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);assert.equal(await p.locator('#confirmShow').isEnabled(),true);
 f.state.failMovie=false;await p.locator('#confirmShow').click();await until(async()=>await p.locator('.movie-card').count()===1);
 assert.match(await p.locator('.movie-card').innerText(),/Watchlist/);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM movie_events').get().n,0);
});
test('stale movie responses cannot overwrite new query, switched tabs or reopened modal',async t=>{
 const f=await setup(t);const p=f.p;await p.getByText('＋ Add movie',{exact:true}).click();let oldRoute;
 await p.route('**/api/movies/search?*',async r=>{if(new URL(r.request().url()).searchParams.get('q')==='old'){oldRoute=r;return;}await r.fulfill({json:[{provider_id:'10',title:'New movie',year:'2021'}]});});
 await p.locator('#providerQuery').fill('old');await until(()=>Boolean(oldRoute));await p.locator('#providerQuery').fill('new');await until(async()=>(await p.locator('#showMatches').innerText()).includes('New movie'));
 await oldRoute.fulfill({json:[{provider_id:'11',title:'Old movie'}]});await p.waitForTimeout(100);assert.match(await p.locator('#showMatches').innerText(),/New movie/);
 oldRoute=null;await p.locator('#providerQuery').fill('old');await until(()=>Boolean(oldRoute));await p.locator('#showTab').click();
 await oldRoute.fulfill({json:[{provider_id:'11',title:'Old movie'}]});await p.waitForTimeout(100);assert.equal(await p.locator('.show-match').count(),0);assert.equal(await p.locator('#movieStatus').count(),0);
 await p.locator('#movieTab').click();oldRoute=null;await p.locator('#providerQuery').fill('old');await until(()=>Boolean(oldRoute));await p.keyboard.press('Escape');await p.getByText('＋ Add movie',{exact:true}).click();
 await oldRoute.fulfill({json:[{provider_id:'11',title:'Old movie'}]});await p.waitForTimeout(100);assert.equal(await p.locator('.show-match').count(),0);await p.locator('#cancelSearch').click();assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM provider_movies').get().n,0);
});
