import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function page(reply) {
  const app = {innerHTML: ''};
  const handlers = {};
  const syncButton = {
    dataset: {sync: ''}, disabled: false, textContent: 'Sync', notice: '',
    hasAttribute: name => name === 'data-sync',
    insertAdjacentHTML(_position, markup) { this.notice = markup; },
  };
  const elements = {'#app': app, '#nav': {}, '#dialog': {}, '#addButton': {}, '[data-sync]': syncButton};
  let requests = 0;
  const document = {
    querySelector: selector => elements[selector],
    addEventListener: (name, callback) => { handlers[name] = callback; },
  };
  const context = vm.createContext({
    document, location: {hash: '#upcoming'}, window: {addEventListener() {}},
    Intl, Date,
    fetch: async path => {
      if (path === '/api/sync/shows') { requests++; return reply(); }
      assert.equal(path, '/api/upcoming');
      return {ok: true, json: async () => []};
    },
  });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    app, syncButton,
    get requests() { return requests; },
    async click() {
      await handlers.click({target: {closest: () => syncButton}});
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('empty data-sync attribute triggers sync and displays its result', async () => {
  const h = await page(() => ({ok: true, json: async () => ({synced: 2, episodes: 30, failures: []})}));
  await h.click();
  assert.equal(h.requests, 1);
  assert.match(h.app.innerHTML, /2 shows and 30 episodes refreshed/);
});

test('in-flight sync disables the button and announces progress', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const h = await page(async () => { await held; return {ok: true, json: async () => ({synced: 1, episodes: 5})}; });
  const clicked = h.click();
  assert.equal(h.syncButton.disabled, true);
  assert.match(h.syncButton.notice, /Syncing every show/);
  release();
  await clicked;
});

test('failed sync explains the error and escapes provider text', async () => {
  const h = await page(() => ({ok: false, json: async () => ({error: 'Missing key <script>'})}));
  await h.click();
  assert.match(h.app.innerHTML, /Sync failed: Missing key &lt;script&gt;/);
  assert.match(h.app.innerHTML, /sync-error/);
});

test('partial sync reports failed shows without claiming full success', async () => {
  const h = await page(() => ({ok: true, json: async () => ({synced: 1, episodes: 5, failures: [{title: 'A', error: 'Unavailable'}]})}));
  await h.click();
  assert.match(h.app.innerHTML, /1 show could not be refreshed/);
});
