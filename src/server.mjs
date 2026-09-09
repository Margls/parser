import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';
import { AUTH_DIR, AUTH_STATE, LOGIN_URL, ROOT_DIR } from './config.mjs';
import { downloadImages, downloadVideos } from './lib/media.mjs';
import { extractSource } from './lib/source.mjs';
import { transferToTarget } from './lib/target.mjs';

const app = express();
const jobs = new Map();
let authRunning = false;

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

async function hasAuth() {
  try { await fs.access(AUTH_STATE); return true; } catch { return false; }
}

app.get('/api/status', async (_req, res) => {
  res.json({ authenticated: await hasAuth(), authRunning });
});

app.post('/api/auth', async (_req, res) => {
  if (authRunning) return res.status(409).json({ error: 'Окно входа уже открыто' });
  authRunning = true;
  res.status(202).json({ ok: true });

  let context;
  try {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(AUTH_DIR, {
      headless: false,
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(url => !url.pathname.startsWith('/user/login'), { timeout: 10 * 60 * 1000 });
    await context.storageState({ path: AUTH_STATE });
  } catch (error) {
    console.error('Ошибка авторизации:', error.message);
  } finally {
    await context?.close().catch(() => {});
    authRunning = false;
  }
});

app.post('/api/transfers', async (req, res) => {
  const sourceUrl = String(req.body?.sourceUrl || '').trim();
  if (!sourceUrl) return res.status(400).json({ error: 'Вставьте ссылку на материал' });
  if (!(await hasAuth())) return res.status(401).json({ error: 'Сначала войдите в EISRF' });
  if ([...jobs.values()].some(job => job.status === 'running')) {
    return res.status(409).json({ error: 'Дождитесь завершения текущего переноса' });
  }

  const id = crypto.randomUUID();
  const job = { id, status: 'running', progress: 2, message: 'Начинаем перенос', logs: [], result: null, error: null };
  jobs.set(id, job);
  res.status(202).json({ id });

  const report = (message, progress) => {
    job.message = message;
    job.progress = progress;
    job.logs.push({ time: new Date().toISOString(), message });
  };

  let jobDir = null;
  try {
    report('Читаем страницу-источник', 8);
    const source = await extractSource(sourceUrl);
    if (!source.title || !source.contentHtml) throw new Error('Не удалось выделить заголовок или содержимое страницы');

    jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ddn-news-transfer-'));
    const imageDir = path.join(jobDir, 'images');
    const videoDir = path.join(jobDir, 'videos');
    const galleryUrls = source.galleryUrls.slice(0, 150);
    const videoUrls = (source.videoUrls || []).slice(0, 10);
    const allUrls = [...new Set([source.mainImageUrl, ...galleryUrls].filter(Boolean))];
    report(`Подготавливаем изображения: ${allUrls.length}`, 20);
    const files = await downloadImages(allUrls, imageDir, (done, total) => {
      report(`Скачано и оптимизировано изображений: ${done} из ${total}`, 20 + Math.round((done / total) * 25));
    });
    const byUrl = new Map(allUrls.map((url, index) => [url, files[index]]));
    const mainImagePath = source.mainImageUrl ? byUrl.get(source.mainImageUrl) : null;
    const galleryFiles = galleryUrls.map(url => byUrl.get(url)).filter(Boolean);
    const videoFiles = await downloadVideos(videoUrls, videoDir, (done, total, state) => {
      const progress = 46 + Math.round((done / total) * 8);
      if (state?.skipped) {
        report(`Видео пропущено (${done} из ${total}): ${state.error}`, progress);
      } else {
        report(`Скачано видео: ${done} из ${total}`, progress);
      }
    });

    const result = await transferToTarget({ source, mainImagePath, galleryFiles, videoFiles, report });
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Готово — материал перенесён';
    job.result = { ...result, title: source.title, images: allUrls.length, videos: videoFiles.length, kind: source.kind };
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.message = 'Перенос остановлен';
    job.logs.push({ time: new Date().toISOString(), message: error.message });
  } finally {
    if (jobDir) {
      try {
        await fs.rm(jobDir, { recursive: true, force: true });
        job.logs.push({ time: new Date().toISOString(), message: 'Временные файлы удалены' });
      } catch (cleanupError) {
        job.logs.push({ time: new Date().toISOString(), message: `Не удалось удалить временные файлы: ${cleanupError.message}` });
      }
    }
  }
});

app.get('/api/transfers/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json(job);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задача не найдена' });
  res.json(job);
});

app.listen(3000, '127.0.0.1', () => {
  console.log('DDN Transfer открыт на http://127.0.0.1:3000');
});
