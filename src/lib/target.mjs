import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { AUTH_STATE } from '../config.mjs';

const SITE_ID = '140990246';
const BASE = `https://lk.eisrf.ru/user/cp/${SITE_ID}`;

function ruDate(iso) {
  if (!iso) throw new Error('Не удалось определить дату исходной новости');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Некорректная дата исходной новости: ${iso}`);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Yekaterinburg',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
}

function slugify(value) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return value.toLowerCase().split('').map(char => map[char] ?? char).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

async function uploadSingle(page, button, filePath) {
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await page.keyboard.press('Escape');
  // The EISRF uploader builds a hidden multipart form from its click handler.
  // Dispatching the event avoids the native picker and lets Playwright populate
  // that form directly, including its normal change/submit callback.
  await button.dispatchEvent('click');
  const input = page.locator('#upload_frame_place input[type="file"], #input-file').first();
  await input.waitFor({ state: 'attached', timeout: 10_000 });
  await input.setInputFiles(filePath);
  await page.waitForFunction(() => {
    const input = document.querySelector('#o1-image');
    return input && input.value;
  }, null, { timeout: 60_000 });
  return page.locator('.qwxedit-file-objref-preview a, .qwxedit-file-objref-preview img')
    .first()
    .evaluate(element => element.getAttribute('href') || element.getAttribute('src'));
}

async function uploadContentFile(page, filePath) {
  await page.waitForFunction(() => window.jQuery?.fn?.qwxFileUploader && window.qwx?.edit2?.get?.()[0], null, {
    timeout: 30_000,
  });
  await page.evaluate(siteId => {
    document.querySelector('#ddn-content-file-uploader')?.remove();
    window.__ddnUploadedContentFile = null;
    window.ddn_content_file_upload_callback = data => {
      window.__ddnUploadedContentFile = data;
    };

    const host = document.createElement('div');
    host.id = 'ddn-content-file-uploader';
    host.innerHTML = '<button type="button" role="file-upload">upload</button>';
    document.body.appendChild(host);
    window.jQuery(host).qwxFileUploader({
      mode: 'file',
      callback: 'ddn_content_file_upload_callback',
      formAction: window.qwx.edit2.uploadUrl,
      json: 1,
      addParams: { org_site: Number(siteId) },
    });
    host.querySelector('[role="file-upload"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, SITE_ID);

  const input = page.locator('#upload_frame_place input[type="file"], #input-file').first();
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  await input.setInputFiles(filePath, { timeout: 120_000 });
  const handle = await page.waitForFunction(() => window.__ddnUploadedContentFile, null, { timeout: 10 * 60_000 });
  const data = await handle.jsonValue();
  if (data?.error) {
    const message = typeof data.error === 'string' ? data.error : data.error.message;
    throw new Error(message || 'EISRF отклонил видеофайл');
  }
  if (!data?.file) throw new Error('EISRF не вернул путь загруженного видео');
  const relativePath = String(data.file).replace(/^\/?media\//i, '').replace(/^\/+/, '');
  return {
    id: data.id || null,
    filename: data.filename || path.basename(relativePath),
    url: `/media/${relativePath}`,
  };
}

function escapeAttribute(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function setPublicationDate(page, iso) {
  const value = ruDate(iso);
  await page.locator('#o1-date').evaluate((input, dateValue) => {
    window.qwx?.edit2?.get?.()[0]?.setFldValue('date', dateValue);
    if (window.jQuery?.fn?.datepicker) {
      window.jQuery(input).datepicker('setDate', dateValue).datepicker('hide');
    }
    input.value = dateValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function saveAndWait(page) {
  const responsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST' && response.url().endsWith('/save2'),
  { timeout: 60_000 });
  await page.locator('[role="save-button"]').click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`EISRF вернул ошибку сохранения: HTTP ${response.status()}`);
  const result = await response.json().catch(() => null);
  if (!result) throw new Error('EISRF вернул пустой ответ при сохранении');
  if (result.error) {
    const message = typeof result.error === 'string' ? result.error : result.error.message;
    throw new Error(message || 'EISRF отклонил сохранение');
  }
  return result;
}

async function findAlbum(page, title) {
  await page.goto(`${BASE}/albums`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table[role="table2"] tbody', { timeout: 30_000 });
  return page.locator('tbody tr').evaluateAll((rows, expected) => {
    const row = rows.find(item => item.querySelector('.fld-title')?.textContent.trim() === expected);
    if (!row) return null;
    const href = row.querySelector('a[role="edit"]')?.href;
    const id = row.dataset.id;
    return href && id ? { href, id } : null;
  }, title);
}

async function createAlbum(page, source, files, report) {
  let album = await findAlbum(page, source.title);
  if (album) {
    report(`Альбом уже существует, продолжаем загрузку: ${source.title}`, 58);
  } else {
    report('Создаём альбом в галерее', 55);
    await page.goto(`${BASE}/albums/new/edit`, { waitUntil: 'domcontentloaded' });
    await page.locator('#o1-title').fill(source.title);
    await page.locator('#o1-uri').fill(`${slugify(source.title)}-${Date.now().toString().slice(-6)}`);
    await setPublicationDate(page, source.publishedAt);
    if (files[0]) await uploadSingle(page, page.locator('[role="file-upload"]'), files[0]);
    await saveAndWait(page);
    album = await findAlbum(page, source.title);
    if (!album?.id) throw new Error('Альбом сохранён, но не найден в списке EISRF');
  }

  const albumId = album.id;
  await page.goto(`${BASE}/albums/${albumId}/edit`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dropzone', { timeout: 30_000 });
  const uploadedCount = await page.evaluate(() => Number(window.V?.album_num_images || 0));
  const remainingFiles = files.slice(Math.min(uploadedCount, files.length));

  for (let index = 0; index < remainingFiles.length; index += 10) {
    const batch = remainingFiles.slice(index, index + 10);
    const firstNumber = uploadedCount + index + 1;
    const lastNumber = uploadedCount + index + batch.length;
    report(`Загружаем фотографии ${firstNumber}–${lastNumber} из ${files.length}`, 62 + Math.round((lastNumber / files.length) * 20));
    await page.goto(`${BASE}/albums/${albumId}/edit`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.dropzone', { timeout: 30_000 });
    const input = page.locator('.dropzone input[type="file"], input.dz-hidden-input').first();
    await input.waitFor({ state: 'attached', timeout: 30_000 });
    await input.setInputFiles(batch);
    await page.waitForFunction(count => document.querySelectorAll('.dz-success').length >= count, batch.length, { timeout: 180_000 });
  }
  return albumId;
}

async function duplicateNews(page, title) {
  await page.goto(`${BASE}/news`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table[role="table2"] tbody', { timeout: 30_000 });
  const filter = page.locator('thead .h-title input[role="filter"]');
  if (await filter.count()) {
    await filter.fill(title);
    await filter.press('Enter');
    await page.waitForTimeout(1500);
  }
  return page.locator('tbody tr').evaluateAll((rows, expected) => {
    const row = rows.find(item => item.querySelector('.fld-title')?.textContent.trim() === expected);
    if (!row) return null;
    return {
      id: row.dataset.id || null,
      editUrl: row.querySelector('a[role="edit"]')?.href || null,
    };
  }, title);
}

export async function transferToTarget({ source, mainImagePath, galleryFiles, videoFiles = [], report }) {
  await fs.access(AUTH_STATE).catch(() => { throw new Error('Сначала выполните вход в EISRF'); });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: AUTH_STATE });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE}/news`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).pathname.startsWith('/user/login')) throw new Error('Сессия EISRF истекла. Выполните вход повторно');
    if (await duplicateNews(page, source.title)) throw new Error('Новость с таким названием уже существует на новом сайте');

    let albumId = null;
    if (galleryFiles.length) albumId = await createAlbum(page, source, galleryFiles, report);

    report('Заполняем новую публикацию', 86);
    await page.goto(`${BASE}/news/new/edit`, { waitUntil: 'domcontentloaded' });
    await page.locator('#o1-title').fill(source.title);
    await setPublicationDate(page, source.publishedAt);
    await page.locator('#o1-annotation').fill(source.annotation || '');

    let previewImageUrl = null;
    if (mainImagePath) {
      previewImageUrl = await uploadSingle(page, page.locator('[role="file-upload"]'), mainImagePath);
    }
    const uploadedVideos = [];
    for (let index = 0; index < videoFiles.length; index += 1) {
      report(`Загружаем видео ${index + 1} из ${videoFiles.length}`, 87 + Math.round(((index + 1) / videoFiles.length) * 5));
      uploadedVideos.push(await uploadContentFile(page, videoFiles[index]));
    }
    const previewHtml = previewImageUrl
      ? `<img src="${escapeAttribute(previewImageUrl)}" alt="${escapeAttribute(source.title)}" style="max-width: 100%; height: auto;"><br><br>`
      : '';
    const videoHtml = uploadedVideos.map(video => {
      const extension = path.extname(video.filename).toLowerCase();
      const mimeType = extension === '.webm' ? 'video/webm' : extension === '.mov' ? 'video/quicktime' : 'video/mp4';
      const url = escapeAttribute(video.url);
      return `<video controls preload="metadata" style="max-width: 100%; height: auto;"><source src="${url}" type="${mimeType}"><a href="${url}">Скачать видео</a></video><br><br>`;
    }).join('\n');
    const contentHtml = `${previewHtml}${videoHtml}${source.contentHtml || ''}`;
    await page.waitForFunction(() => window.tinymce?.get('o1-text'), null, { timeout: 30_000 });
    await page.evaluate(html => {
      const editor = window.tinymce.get('o1-text');
      editor.setContent(html);
      editor.save();
    }, contentHtml);

    if (albumId) {
      await page.locator('#o1-org_site_album').evaluate((input, value) => {
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, albumId);
    }

    report('Сохраняем публикацию', 94);
    await saveAndWait(page);
    const created = await duplicateNews(page, source.title);
    const newsId = created?.id;
    if (!newsId) throw new Error('Новость сохранена, но не найдена в списке EISRF');
    return {
      adminUrl: created.editUrl || `${BASE}/news/${newsId}/edit`,
      publicUrl: newsId ? `http://ddn-mgn.chel.muzkult.ru/news/${newsId}` : 'http://ddn-mgn.chel.muzkult.ru/news',
      albumId,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
