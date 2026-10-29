import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { chromium } from 'playwright';

// Keep all target traffic inside the fixture; tests never publish to EISRF.
mock.module('../src/config.mjs', { namedExports: { AUTH_STATE: import.meta.filename } });
const { transferAlbumToTarget } = await import('../src/lib/target.mjs');
const launch = chromium.launch.bind(chromium);
const base = 'https://lk.eisrf.ru/user/cp/140990246';
const source = { title: 'Праздник', publishedAt: '2026-10-01', galleryUrls: ['https://ddnmgn.ru/photo.jpg'] };

async function targetFixture(t, pages) {
  const browser = await launch({ headless: true });
  t.after(() => browser.close());
  const newContext = browser.newContext.bind(browser);
  const state = { created: 0, uploads: 0, saves: 0, pagesRead: [], publicStatus: 200 };
  mock.method(chromium, 'launch', async () => browser);
  mock.method(browser, 'newContext', async () => {
    const context = await newContext();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const send = body => route.fulfill({ contentType: 'text/html; charset=utf-8', body });
      if (url.hostname === 'ddn-mgn.chel.muzkult.ru') {
        assert.equal((await context.cookies()).length, 0);
        if (state.publicStatus !== 200) return route.fulfill({ status: state.publicStatus, body: 'Unavailable' });
        if (url.pathname === '/') return send('<a href="/news/1">Праздник</a><a href="/foto">Фотогалерея</a>');
        if (url.pathname === '/foto' && !url.search) return send('<a href="/foto?page=2" rel="next">Далее</a>');
        if (url.pathname === '/foto') return send('<a href="/foto/prazdnik"><h3>Праздник</h3></a>');
        if (url.pathname === '/foto/prazdnik') return send('<h1>Праздник</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">');
        throw new Error(`Unexpected public request: ${url.href}`);
      }
      if (url.pathname.endsWith('/save2')) {
        state.saves++;
        state.created++;
        pages[0].push({ id: '123', title: source.title });
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.endsWith('/uploaded')) {
        state.uploads += Number(url.searchParams.get('count'));
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname.endsWith('/fixture-page')) {
        const index = Number(url.searchParams.get('index'));
        state.pagesRead.push(index + 1);
        return route.fulfill({ json: pages[index] });
      }
      if (url.pathname.endsWith('/albums')) {
        state.pagesRead.push(1);
        return send(`<table role="table2"><tbody></tbody></table><script>
          const pages = ${JSON.stringify(pages)};
          function render(rows) {
            const body = document.querySelector('tbody'); body.replaceChildren();
            for (const album of rows) {
              const row = document.createElement('tr'); row.dataset.id = album.id;
              const title = document.createElement('td'); title.className = 'fld-title'; title.textContent = album.title;
              const link = document.createElement('a'); link.setAttribute('role','edit'); link.href = '${base}/albums/' + album.id + '/edit';
              row.append(title,link); body.append(row);
            }
          }
          render(pages[0]);
          const table = { table: { is: () => true }, pager: { current: 1, last_page: pages.length },
            async pageLoad(number, options, cb) {
              const response = await fetch('/fixture-page?index='+(number-1));
              render(await response.json()); this.pager.current = number; cb();
            }
          };
          window.qwx = { table2: { get: () => [table] } };
        </script>`);
      }
      if (url.pathname.endsWith('/albums/new/edit')) {
        return send(`<input id="o1-title"><input id="o1-uri"><input id="o1-date"><input id="o1-image">
          <button role="file-upload" onclick="document.querySelector('#input-file').value=''">Upload</button>
          <input id="input-file" type="file" onchange="document.querySelector('#o1-image').value='cover.jpg'">
          <div class="qwxedit-file-objref-preview"><a href="/cover.jpg">Cover</a></div>
          <button role="save-button" onclick="fetch('/save2',{method:'POST'})">Save</button>`);
      }
      if (url.pathname.endsWith('/albums/123/edit')) {
        return send(`<div class="dropzone"><input type="file" multiple></div><script>
          window.V = { album_num_images: ${state.uploads} };
          document.querySelector('input').onchange = async event => {
            const count = event.target.files.length;
            await fetch('/uploaded?count='+count, {method:'POST'});
            for (let i=0;i<count;i++) {
              const done = document.createElement('div'); done.className = 'dz-success'; document.body.append(done);
            }
          };
        </script>`);
      }
      throw new Error(`Unexpected target request: ${url.pathname}`);
    });
    return context;
  });
  t.after(() => mock.restoreAll());
  return state;
}

test('existing album on a later page returns its link without preparing or uploading files', async t => {
  const state = await targetFixture(t, [[{ id: '1', title: 'Другое событие' }], [{ id: '42', title: '  ПРАЗДНИК  ' }]]);
  const result = await transferAlbumToTarget({
    source: { ...source, galleryUrls: [] },
    prepareFiles: () => assert.fail('Existing album must not download files'),
    report() {},
  });
  assert.equal(result.existed, true);
  assert.equal(result.albumUrl, `${base}/albums/42/edit`);
  assert.equal(result.publicUrl, 'http://ddn-mgn.chel.muzkult.ru/foto/prazdnik');
  assert.deepEqual(state.pagesRead, [1, 2]);
  assert.equal(state.saves, 0);
  assert.equal(state.uploads, 0);
});

test('missing album uses the existing creation and photo upload flow', async t => {
  const state = await targetFixture(t, [[{ id: '1', title: 'Праздник другой' }], []]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddn-album-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'photo.jpg');
  await fs.writeFile(image, 'fixture image');
  let prepared = 0;
  const result = await transferAlbumToTarget({ source, prepareFiles: async () => { prepared++; return [image]; }, report() {} });
  assert.equal(result.existed, false);
  assert.equal(result.albumUrl, `${base}/albums/123/edit`);
  assert.equal(result.publicUrl, 'http://ddn-mgn.chel.muzkult.ru/foto/prazdnik');
  assert.equal(result.images, 1);
  assert.equal(prepared, 1);
  assert.equal(state.saves, 1);
  assert.equal(state.uploads, 1);
});

test('missing album with no photos fails without creating an empty album', async t => {
  const state = await targetFixture(t, [[]]);
  await assert.rejects(transferAlbumToTarget({
    source: { ...source, galleryUrls: [] }, prepareFiles: () => assert.fail('No photos'), report() {},
  }), /не найдены фотографии/);
  assert.equal(state.saves, 0);
});

test('album appearing during file preparation is returned without uploading a duplicate', async t => {
  const pages = [[]];
  const state = await targetFixture(t, pages);
  const result = await transferAlbumToTarget({
    source,
    prepareFiles: async () => {
      pages[0].push({ id: '77', title: source.title });
      return ['unused.jpg'];
    },
    report() {},
  });
  assert.equal(result.existed, true);
  assert.equal(result.albumUrl, `${base}/albums/77/edit`);
  assert.equal(state.saves, 0);
  assert.equal(state.uploads, 0);
});

test('an unavailable public site keeps the existing album and its admin link', async t => {
  const state = await targetFixture(t, [[{ id: '42', title: source.title }]]);
  state.publicStatus = 403;
  const result = await transferAlbumToTarget({ source, prepareFiles: () => assert.fail('Existing album'), report() {} });
  assert.equal(result.publicUrl, null);
  assert.equal(result.adminUrl, `${base}/albums/42/edit`);
  assert.equal(result.existed, true);
});

test('tabs submit to the matching endpoint and display duplicate, creation and publication results', async t => {
  const browser = await launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let outcome = 'existing';
  const requests = [];
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/status') return route.fulfill({ json: { authenticated: true } });
    if (url.pathname === '/api/albums' || url.pathname === '/api/transfers') {
      requests.push({ endpoint: url.pathname, body: route.request().postDataJSON() });
      return route.fulfill({ status: 202, json: { id: 'test' } });
    }
    if (url.pathname === '/api/jobs/test') {
      if (outcome === 'failed') return route.fulfill({ json: { status: 'failed', progress: 15, logs: [], error: 'Сессия EISRF истекла' } });
      const result = outcome === 'publication'
        ? { title: 'Новость', images: 1, publicUrl: 'https://example.test/news/1', kind: 'article' }
        : { title: 'Праздник', images: 1, albumUrl: `${base}/albums/42/edit`, publicUrl: outcome === 'existing' ? 'http://ddn-mgn.chel.muzkult.ru/foto/prazdnik' : null, kind: 'photo-album', existed: outcome === 'existing' };
      return route.fulfill({ json: { status: 'completed', progress: 100, logs: [], message: 'Готово', result } });
    }
    const filename = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const contentType = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ contentType, body: await fs.readFile(new URL(`../public/${filename}`, import.meta.url)) });
  });
  await page.goto('http://ddn.test/');
  await page.locator('#sourceUrl').fill('https://ddnmgn.ru/novosti/test');
  await page.getByRole('tab', { name: 'Фотоальбом' }).click();
  await page.locator('#sourceUrl').fill('https://ddnmgn.ru/album/test');
  await page.locator('#transferButton').click();
  await page.getByRole('heading', { name: 'Альбом существует', exact: true }).waitFor();
  assert.equal(await page.locator('#toast').textContent(), 'Альбом существует');
  assert.equal(await page.getByRole('link', { name: 'Открыть альбом в EISRF' }).getAttribute('href'), `${base}/albums/42/edit`);
  assert.equal(await page.getByRole('link', { name: 'Открыть альбом на сайте' }).getAttribute('href'), 'http://ddn-mgn.chel.muzkult.ru/foto/prazdnik');
  assert.equal(requests[0].endpoint, '/api/albums');
  assert.equal(requests[0].body.sourceUrl, 'https://ddnmgn.ru/album/test');
  outcome = 'created';
  await page.locator('#transferButton').click();
  await page.getByRole('heading', { name: 'Альбом создан', exact: true }).waitFor();
  assert.match(await page.locator('#result').textContent(), /Фотографий: 1/);
  assert.equal(await page.getByRole('link', { name: 'Открыть альбом на сайте' }).count(), 0);
  assert.match(await page.locator('#result').textContent(), /Страница альбома на сайте пока недоступна/);
  await page.getByRole('tab', { name: 'Публикации', exact: true }).click();
  assert.equal(await page.locator('#sourceUrl').inputValue(), 'https://ddnmgn.ru/novosti/test');
  outcome = 'publication';
  await page.locator('#transferButton').click();
  await page.getByRole('heading', { name: 'Материал перенесён', exact: true }).waitFor();
  assert.equal(requests.at(-1).endpoint, '/api/transfers');
  await page.getByRole('tab', { name: 'Фотоальбом' }).click();
  outcome = 'failed';
  await page.locator('#transferButton').click();
  await page.getByRole('heading', { name: 'Нужна проверка', exact: true }).waitFor();
  assert.equal(await page.locator('#statusMessage').textContent(), 'Сессия EISRF истекла');
  assert.equal(await page.locator('#transferButton').isEnabled(), true);
  assert.equal(await page.getByRole('tab', { name: 'Публикации', exact: true }).isEnabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(failures, []);
});
