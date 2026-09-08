import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ARTIFACTS_DIR, AUTH_STATE, LOGIN_URL } from './config.mjs';

await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

try {
  await fs.access(AUTH_STATE);
} catch {
  console.error(`Нет сохранённой сессии. Сначала выполните: npm run auth (${LOGIN_URL})`);
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1000 },
  storageState: AUTH_STATE,
});
const page = await context.newPage();
const startUrl = process.argv[2] || 'https://lk.eisrf.ru/user';
await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
await page.waitForTimeout(1_000);

if (new URL(page.url()).pathname.startsWith('/user/login')) {
  console.error(`Сессия не авторизована. Сначала выполните: npm run auth (${LOGIN_URL})`);
  await context.close();
  process.exit(2);
}

const inspection = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  headings: [...document.querySelectorAll('h1, h2, h3')].map(node => node.textContent.trim()).filter(Boolean),
  links: [...document.querySelectorAll('a[href]')].map(node => ({
    text: node.textContent.trim().replace(/\s+/g, ' '),
    href: new URL(node.getAttribute('href'), location.href).href,
  })).filter(item => item.text),
  forms: [...document.forms].map(form => ({
    action: new URL(form.getAttribute('action') || location.href, location.href).href,
    method: form.method,
    fields: [...form.elements].map(field => ({
      tag: field.tagName.toLowerCase(),
      type: field.type || null,
      name: field.name || null,
      id: field.id || null,
      placeholder: field.placeholder || null,
    })),
  })),
  controls: [...document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"], [onclick]')]
    .map(node => ({
      tag: node.tagName.toLowerCase(),
      text: (node.textContent || node.value || node.title || '').trim().replace(/\s+/g, ' '),
      id: node.id || null,
      className: typeof node.className === 'string' ? node.className : null,
      title: node.getAttribute('title'),
      name: node.getAttribute('name'),
      value: node.getAttribute('value'),
      href: node.getAttribute('href'),
      onclick: node.getAttribute('onclick'),
      data: { ...node.dataset },
    })),
}));

await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'admin-inspection.png'), fullPage: true });
await fs.writeFile(
  path.join(ARTIFACTS_DIR, 'admin-inspection.json'),
  JSON.stringify(inspection, null, 2),
  'utf8',
);
await fs.writeFile(path.join(ARTIFACTS_DIR, 'admin-inspection.html'), await page.content(), 'utf8');
console.log(`Кабинет исследован: ${inspection.url}; ссылок: ${inspection.links.length}`);
await context.close();
await browser.close();
