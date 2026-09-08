import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { ARTIFACTS_DIR, AUTH_DIR, AUTH_STATE, LOGIN_URL } from './config.mjs';

await fs.mkdir(AUTH_DIR, { recursive: true });
await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(AUTH_DIR, {
  headless: false,
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1000 },
});

const page = context.pages()[0] ?? await context.newPage();
await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

console.log('Войдите в кабинет в открывшемся окне. Пароль останется в браузере.');
console.log('После успешного входа скрипт сам сохранит снимок кабинета и завершится.');

await page.waitForURL(url => !url.pathname.startsWith('/user/login'), { timeout: 10 * 60 * 1000 });
await page.waitForLoadState('domcontentloaded');
await page.screenshot({ path: `${ARTIFACTS_DIR}/admin-home.png`, fullPage: true });
await fs.writeFile(`${ARTIFACTS_DIR}/admin-home.html`, await page.content(), 'utf8');
await fs.writeFile(
  `${ARTIFACTS_DIR}/admin-home-url.txt`,
  `${page.url()}\n`,
  'utf8',
);
await context.storageState({ path: AUTH_STATE });

console.log(`Вход выполнен: ${page.url()}`);
await context.close();
