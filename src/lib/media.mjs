import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { request } from 'playwright';
import { ROOT_DIR } from '../config.mjs';

const execFileAsync = promisify(execFile);
const YT_DLP_PATH = path.join(ROOT_DIR, 'tools', 'yt-dlp.exe');
const MAX_VIDEO_BYTES = 3 * 1024 * 1024;

function safeName(url, index) {
  const original = decodeURIComponent(new URL(url).pathname.split('/').pop() || `image-${index}.jpg`);
  const stem = original.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '-').slice(0, 80) || `image-${index}`;
  return `${String(index).padStart(3, '0')}-${stem}.jpg`;
}

export async function downloadImages(urls, outputDir, onProgress = () => {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const api = await request.newContext({ ignoreHTTPSErrors: true });
  const files = [];

  try {
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      const response = await api.get(url, { timeout: 60_000 });
      if (!response.ok()) throw new Error(`Не удалось скачать изображение (${response.status()}): ${url}`);
      const outputPath = path.join(outputDir, safeName(url, index + 1));
      const input = await response.body();
      await sharp(input, { animated: false })
        .rotate()
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(outputPath);
      const stat = await fs.stat(outputPath);
      if (stat.size > 2 * 1024 * 1024) {
        await sharp(input)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70, mozjpeg: true })
          .toFile(`${outputPath}.smaller`);
        await fs.rename(`${outputPath}.smaller`, outputPath);
      }
      files.push(outputPath);
      onProgress(index + 1, urls.length);
    }
  } finally {
    await api.dispose();
  }
  return files;
}

export async function downloadVideos(urls, outputDir, onProgress = () => {}) {
  if (!urls.length) return [];
  await fs.access(YT_DLP_PATH).catch(() => {
    throw new Error('Не найден tools/yt-dlp.exe — загрузчик видео не установлен');
  });
  await fs.mkdir(outputDir, { recursive: true });
  const files = [];

  for (let index = 0; index < urls.length; index += 1) {
    const outputTemplate = path.join(
      outputDir,
      `video-${String(index + 1).padStart(3, '0')}-%(id)s.%(ext)s`,
    );
    try {
      const { stdout } = await execFileAsync(YT_DLP_PATH, [
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '--windows-filenames',
        '--restrict-filenames',
        '--socket-timeout', '60',
        '--retries', '3',
        '--max-filesize', '3M',
        '--format', 'url144/worst[ext=mp4]',
        '--output', outputTemplate,
        '--print', 'after_move:filepath',
        urls[index],
      ], {
        windowsHide: true,
        timeout: 20 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const candidates = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      const outputPath = candidates.at(-1);
      if (!outputPath) throw new Error('не найден MP4 размером до 3 МБ');
      const stat = await fs.stat(outputPath);
      if (stat.size > MAX_VIDEO_BYTES) {
        await fs.rm(outputPath, { force: true });
        throw new Error(`минимальная доступная версия видео больше 3 МБ (${(stat.size / 1024 / 1024).toFixed(1)} МБ)`);
      }
      files.push(outputPath);
      onProgress(index + 1, urls.length);
    } catch (error) {
      const details = String(error.stderr || error.message || error).trim().split(/\r?\n/).at(-1);
      throw new Error(`Не удалось скачать видео ${urls[index]}: ${details}`);
    }
  }
  return files;
}
