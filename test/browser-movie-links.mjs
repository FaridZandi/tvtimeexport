import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures.mjs';
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}assert.fail('Timed out waiting for browser state');}
async function setup(t,viewport={width:1280,height:900},csv='movie_name,release_date\nDune,2021-01-01\n'){
 const dir=mkdtempSync(join(tmpdir(),'reeltime-link-ui-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'source.csv');writeFileSync(path,csv);
 const f=await fixture({movieSourcePath:path});t.after(()=>f.close());
 f.db.exec("INSERT INTO movie_events (title,event_type,event_key,event_at,watch_date,rewatch_count) VALUES ('Dune','watch','original','2000-01-01','1999-01-01','2'); INSERT INTO custom_movies VALUES ('Dune','watchlist','5','2000-01-01','2000-01-01')");
 const b=await chromium.launch({headless:true});t.after(()=>b.close());const p=await b.newPage({viewport});await p.route('https://**',r=>r.abort());await p.goto(f.url+'/#movies');return {...f,p};
}
async function matches(p){await until(async()=>await p.locator('.show-match').count()===3 && await p.locator('.show-match').first().isVisible());}

test('legacy card: skip, year-based suggestions, keyboard link, correction and undo preserve original records',async t=>{
 const f=await setup(t),p=f.p;const events=f.db.prepare('SELECT * FROM movie_events').all(),custom=f.db.prepare('SELECT * FROM custom_movies').all();
 await p.getByRole('button',{name:'Link movie data',exact:true}).click();await matches(p);
 assert.equal(await p.locator('#confirmShow').isEnabled(),false);assert.equal(await p.locator('#movieStatus').count(),0);
 assert.match(await p.locator('.show-match').first().innerText(),/2021/);
 await p.getByText('Skip for now',{exact:true}).click();assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_movie_links').get().n,0);
 await p.getByRole('button',{name:'Link movie data',exact:true}).click();await matches(p);await p.locator('.show-match').first().focus();await p.keyboard.press('Enter');
 await p.screenshot({path:join(tmpdir(),'REEL-009-link-desktop.png')});
 await p.locator('#confirmShow').focus();await p.keyboard.press('Enter');await until(async()=>await p.getByText('Change movie link',{exact:true}).count()===1);
 assert.match(await p.locator('.movie-card').innerText(),/2021[\s\S]*Watched[\s\S]*Watchlist/);
 await p.getByText('Change movie link',{exact:true}).click();await matches(p);await p.locator('.show-match').nth(1).click();await p.locator('#confirmShow').click();
 await until(async()=>(await p.locator('.movie-card').innerText()).includes('1984'));
 p.once('dialog',d=>d.accept());await p.getByText('Undo link',{exact:true}).click();await until(async()=>await p.getByRole('button',{name:'Link movie data',exact:true}).count()===1);
 assert.deepEqual(f.db.prepare('SELECT * FROM movie_events').all(),events);assert.deepEqual(f.db.prepare('SELECT * FROM custom_movies').all(),custom);
});
test('390px review queue: bulk preparation can stop/resume without auto-linking; skip and failed link retry',async t=>{
 const f=await setup(t,{width:390,height:844}),p=f.p;
 f.db.exec("INSERT INTO custom_movies VALUES ('Other film','watchlist','','2000-01-01','2000-01-01')");
 await p.getByText('Review movie links',{exact:true}).click();await until(async()=>await p.locator('.movie-link-review').count()===2);
 let held;let requests=0;
 await p.route('**/api/movies/link-suggestions?*',async r=>{requests++;if(requests===2){held=r;return;}await r.continue();});
 await p.locator('#prepareMovieLinks').click();await until(()=>Boolean(held));await p.getByText('Stop preparation',{exact:true}).click();await held.continue();
 await until(async()=>(await p.locator('.sync-notice').innerText()).includes('Preparation stopped'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_movie_links').get().n,0);
 await p.locator('#prepareMovieLinks').click();await until(async()=>(await p.locator('.sync-notice').innerText()).includes('Prepared 2'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_movie_suggestions').get().n,2);
 await p.locator('[data-link-legacy="Dune"]').click();await matches(p);await p.getByText('Skip for now',{exact:true}).click();
 await until(async()=>(await p.locator('.movie-link-review').first().innerText()).includes('Skipped for now'));
 await p.locator('[data-link-legacy="Dune"]').click();await matches(p);await p.locator('.show-match').first().click();
 assert.equal(await p.evaluate(()=>document.querySelector('#dialog').scrollWidth<=document.querySelector('#dialog').clientWidth),true);
 await p.screenshot({path:join(tmpdir(),'REEL-009-link-mobile.png')});
 f.state.failMovie=true;await p.locator('#confirmShow').click();await until(async()=>(await p.locator('#confirmShow').innerText()).includes('Retry link'));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_movie_links').get().n,0);f.state.failMovie=false;await p.locator('#confirmShow').click();
 await until(async()=>await p.getByText('Change movie link',{exact:true}).count()===1);
});
test('ambiguous years require review and newer searches replace cached suggestions',async t=>{
 const f=await setup(t,{width:390,height:844},'movie_name,release_date\nDune,2021-01-01\nDune,1984-01-01\n'),p=f.p;
 await p.getByRole('button',{name:'Link movie data',exact:true}).click();await matches(p);
 assert.match(await p.locator('#dialog').innerText(),/Multiple release years found/);
 let stale; await p.route('**/api/movies/link-suggestions?*',async route=>{stale=route;});
 await p.locator('#retrySearch').click();await until(()=>Boolean(stale));
 await p.locator('#movieMatchYear').fill('2021');await matches(p);await until(async()=>(await p.locator('.show-match').first().innerText()).includes('2021'));
 await stale.fulfill({json:{matches:[]}});await p.waitForTimeout(100);assert.match(await p.locator('.show-match').first().innerText(),/2021/);
 await p.locator('#cancelSearch').click();assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM legacy_movie_links').get().n,0);
});
