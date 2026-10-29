const PUBLIC_SITE = 'http://ddn-mgn.chel.muzkult.ru/';

export async function findPublicAlbumUrl(browser, title, report) {
  let context;
  try {
    // Public availability must be checked without the administrator's session.
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const pending = [PUBLIC_SITE];
    const visited = new Set();
    const deadline = Date.now() + 30_000;
    let siteOrigin;
    while (pending.length && visited.size < 20 && Date.now() < deadline) {
      const url = pending.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(15_000, Math.max(1, deadline - Date.now())) });
      if (!response?.ok()) continue;
      if (!siteOrigin) siteOrigin = new URL(page.url()).origin;
      if (new URL(page.url()).origin !== siteOrigin) continue;
      const links = await page.evaluate(({ expected, origin }) => {
        const normalize = value => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU');
        const album = [];
        const sections = [];
        for (const link of document.querySelectorAll('a[href]')) {
          const url = new URL(link.href, location.href);
          if (url.origin !== origin || !/^https?:$/.test(url.protocol)
            || /\/(?:news|novosti|novost)(?:\/|$)/i.test(url.pathname)) continue;
          url.hash = '';
          if (url.href === location.href) continue;
          const labels = [link.textContent, link.title, link.querySelector('img')?.alt,
            ...[...link.querySelectorAll('h2, h3, h4, .title, .name')].map(node => node.textContent)];
          if (labels.some(value => normalize(value) === normalize(expected))) album.push(url.href);
          else if (/фото|галере|альбом|gallery|albums?|photos?/i.test(`${link.textContent} ${url.pathname}`)
            || link.matches('[rel="next"], .pagination a, .pager a, [class*="pagin"] a')) sections.push(url.href);
        }
        return { album: [...new Set(album)], sections: [...new Set(sections)] };
      }, { expected: title, origin: siteOrigin });

      for (const candidate of links.album) {
        if (Date.now() >= deadline) break;
        const detail = await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: Math.min(15_000, Math.max(1, deadline - Date.now())) });
        if (!detail?.ok() || new URL(page.url()).origin !== siteOrigin) continue;
        const matches = await page.evaluate(expected => {
          const normalize = value => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru-RU');
          return [...document.querySelectorAll('h1, h2, [itemprop="name"]')]
            .some(node => normalize(node.textContent) === normalize(expected));
        }, title);
        if (matches) return page.url();
      }
      pending.push(...links.sections.filter(link => !visited.has(link)));
    }
    report('Публичная страница альбома не найдена — ссылка в EISRF сохранена', 98);
    return null;
  } catch (error) {
    report(`Не удалось проверить ссылку на сайте: ${error.message}. Ссылка в EISRF сохранена`, 98);
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}
