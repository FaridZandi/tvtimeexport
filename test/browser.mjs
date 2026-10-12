import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fixture } from './fixtures.mjs';

async function setup(t, viewport = {width:1280,height:900}) {
  const f = await fixture(); t.after(() => f.close());
  const browser = await chromium.launch({headless:true}); t.after(() => browser.close());
  const page = await browser.newPage({viewport});
  await page.route('https://**', route => route.abort());
  await page.goto(f.url + '/#shows'); await page.locator('#addButton').click();
  return {...f, page};
}
async function until(fn) { for (let i=0;i<100;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,50)); } assert.fail('Timed out waiting for browser state'); }

test('desktop: typing, three previews, keyboard selection, explicit confirmation, sync feedback and populated show', async t => {
  const f = await setup(t); const p = f.page;
  await p.locator('#providerQuery').fill('Bear');
  await until(async () => await p.locator('.show-match').count() === 3);
  assert.match(await p.locator('.show-match').first().innerText(), /Bear[\s\S]*2022[\s\S]*2 seasons · 2 episodes/);
  await until(async () => await p.locator('.match-art [aria-label="No artwork"]').count() === 3);
  assert.equal(await p.locator('#confirmShow').isDisabled(), true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 0);
  await p.locator('.show-match').first().focus(); await p.keyboard.press('Enter');
  assert.equal(await p.locator('.show-match').first().getAttribute('aria-pressed'), 'true');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 0);
  await p.screenshot({path:join(tmpdir(),'REEL-006-desktop.png')});
  let release; const held = new Promise(r=>release=r);
  await p.route('**/api/shows', async route => { if (route.request().method() === 'POST') await held; await route.continue(); });
  await p.locator('#confirmShow').focus(); await p.keyboard.press('Enter');
  await until(async () => (await p.locator('#searchStatus').innerText()).includes('Loading the complete'));
  assert.equal(await p.locator('#confirmShow').isDisabled(), true); release();
  await until(async () => await p.locator('.episode-row').count() === 2);
  assert.match(await p.locator('h1').innerText(), /Bear/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n, 1);
});

test('390px: unknown counts, no results, failed search retry, failed confirmation retry and no overflow', async t => {
  const f = await setup(t, {width:390,height:844}); const p=f.page;
  await p.locator('#providerQuery').fill('Bear');
  await until(async () => await p.locator('.show-match').count() === 3);
  assert.equal(await p.evaluate(() => document.querySelector('#dialog').scrollWidth <= document.querySelector('#dialog').clientWidth), true);
  await p.locator('#confirmShow').scrollIntoViewIfNeeded();
  await p.screenshot({path:join(tmpdir(),'REEL-006-mobile-three.png')});
  f.state.results=[]; await p.locator('#providerQuery').fill('none');
  await until(async () => (await p.locator('#searchStatus').innerText()).includes('No shows found'));
  f.state.results=[{tvdb_id:'1', name:'Bear', year:'2022'}]; f.state.failSearch=true;
  await p.locator('#providerQuery').fill('Bear');
  await until(async () => await p.locator('#retrySearch').isVisible());
  assert.match(await p.locator('#searchStatus').innerText(), /Search failed/);
  f.state.failSearch=false; f.state.failPage=true; await p.locator('#retrySearch').click();
  await until(async () => await p.locator('.show-match').count() === 1);
  assert.match(await p.locator('.show-match').innerText(), /Seasons unknown · Episodes unknown/);
  await p.locator('.show-match').click();
  assert.equal(await p.evaluate(() => document.querySelector('#dialog').scrollWidth <= document.querySelector('#dialog').clientWidth), true);
  await p.screenshot({path:join(tmpdir(),'REEL-006-mobile.png')});
  await p.locator('#confirmShow').click();
  await until(async () => (await p.locator('#confirmShow').innerText()).includes('Retry add'));
  assert.match(await p.locator('#searchStatus').innerText(), /library was preserved/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n,0);
  f.state.failPage=false; await p.locator('#confirmShow').click();
  await until(async () => await p.locator('.episode-row').count() === 2);
});

test('late responses cannot overwrite newer query or a reopened modal; cancel never adds', async t => {
  const f = await setup(t); const p=f.page; let oldRoute;
  await p.route('**/api/shows/search?*', async route => {
    const q=new URL(route.request().url()).searchParams.get('q');
    if(q==='old') {oldRoute=route;return;}
    await route.fulfill({json:[{provider_id:'9',title:'New match',season_count:1,episode_count:2}]});
  });
  await p.locator('#providerQuery').fill('old'); await until(()=>Boolean(oldRoute));
  await p.locator('#providerQuery').fill('new'); await until(async () => (await p.locator('#showMatches').innerText()).includes('New match'));
  await oldRoute.fulfill({json:[{provider_id:'8',title:'Old match'}]});
  await p.waitForTimeout(100); assert.equal(await p.locator('.show-match').count(),1);
  assert.match(await p.locator('#showMatches').innerText(), /New match/);
  oldRoute=null; await p.locator('#providerQuery').fill('old'); await until(()=>Boolean(oldRoute));
  await p.keyboard.press('Escape'); await p.locator('#addButton').click();
  await oldRoute.fulfill({json:[{provider_id:'8',title:'Old match'}]}); await p.waitForTimeout(100);
  assert.equal(await p.locator('.show-match').count(),0);
  await p.locator('#cancelSearch').click(); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM custom_shows').get().n,0);
});
