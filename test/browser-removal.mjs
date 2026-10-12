import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fixture } from './fixtures.mjs';

async function until(fn) { for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));} assert.fail('Timed out waiting for browser state'); }
async function setup(t,viewport={width:1280,height:900}) {
  const f=await fixture();t.after(()=>f.close());
  f.db.exec("INSERT INTO custom_shows (show_key,title) VALUES ('local:first','Pantheon'), ('local:second','Pantheon')");
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport});await page.route('https://**',r=>r.abort());
  return {...f,page};
}
async function openRemoval(p) {await p.getByText('Manage show',{exact:true}).click();await p.locator('[data-remove-show]').click();}

test('empty duplicate: tucked-away removal, exact title guard, keyboard confirmation, history notice and restore', async t=>{
  const f=await setup(t);const p=f.page;
  await p.goto(f.url+'/#show/local%3Afirst');
  assert.equal(await p.locator('[data-remove-show]').isVisible(),false);
  await openRemoval(p);
  assert.match(await p.locator('.removal-identity').innerText(),/Entry first/);
  assert.equal(await p.locator('#confirmRemoval').isDisabled(),true);
  await p.locator('#removeTitle').fill('pantheon');assert.equal(await p.locator('#confirmRemoval').isDisabled(),true);
  await p.keyboard.press('Escape');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM removed_shows').get().n,0);
  await p.locator('[data-remove-show]').click();await p.locator('#removeTitle').fill('Pantheon');
  assert.equal(await p.locator('#confirmRemoval').isEnabled(),true);
  await p.screenshot({path:join(tmpdir(),'REEL-007-removal-desktop.png')});
  await p.locator('#confirmRemoval').focus();await p.keyboard.press('Enter');
  await until(async()=>await p.locator('.removed-library').count()===1);
  assert.match(await p.locator('.sync-notice').innerText(),/Watch history kept/);
  assert.equal(await p.locator('.show-card').count(),1);
  await p.goto(f.url+'/#show/local%3Afirst');
  await until(async()=>await p.getByText('Show unavailable',{exact:true}).isVisible());
  await p.getByText('Back to library',{exact:true}).click();
  await until(async()=>await p.locator('.removed-library').count()===1);
  await p.locator('.removed-library summary').click();
  assert.match(await p.locator('.removed-show').innerText(),/Entry first/);
  await p.locator('[data-restore-show]').click();
  await until(async()=>await p.locator('.show-card').count()===2);
  assert.equal(await p.locator('.removed-library').count(),0);
});

test('390px populated show: error leaves selection retryable; removal preserves watches and restores progress', async t=>{
  const f=await setup(t,{width:390,height:844});const p=f.page;
  await f.request('/api/shows',{provider_id:'1'});await f.request('/api/episodes/100/watch',{});
  await p.goto(f.url+'/#show/tvdb%3A1');await openRemoval(p);
  assert.match(await p.locator('#removeShowForm').innerText(),/1 watch event/);
  assert.match(await p.locator('.removal-identity').innerText(),/TheTVDB 1/);
  await p.locator('#removeTitle').fill('Bear');
  assert.equal(await p.evaluate(()=>document.querySelector('#dialog').scrollWidth<=document.querySelector('#dialog').clientWidth),true);
  await p.screenshot({path:join(tmpdir(),'REEL-007-removal-mobile.png')});
  let fail=true;
  await p.route('**/api/shows/*/remove',async route=>{if(fail)await route.fulfill({status:500,json:{error:'Temporary failure'}});else await route.continue();});
  await p.locator('#confirmRemoval').click();await until(async()=>(await p.locator('#removeStatus').innerText()).includes('Removal failed'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM removed_shows').get().n,0);
  assert.equal(await p.locator('#confirmRemoval').isEnabled(),true);
  fail=false;await p.locator('#confirmRemoval').click();await until(async()=>await p.locator('.removed-library').count()===1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM episode_watches').get().n,1);
  await p.locator('.removed-library summary').click();
  let restoreFail=true;
  await p.route('**/api/shows/*/restore',async route=>{if(restoreFail)await route.fulfill({status:500,json:{error:'Restore unavailable'}});else await route.continue();});
  await p.locator('[data-restore-show]').click();await until(async()=>(await p.locator('#restoreStatus').innerText()).includes('Restore failed'));
  assert.equal(await p.locator('[data-restore-show]').isEnabled(),true);
  restoreFail=false;await p.locator('[data-restore-show]').click();await until(async()=>await p.locator('.removed-library').count()===0);
  await p.goto(f.url+'/#show/tvdb%3A1');await until(async()=>await p.locator('.episode-row.watched').count()===1);
});
