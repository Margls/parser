import { chromium } from 'playwright';

function isAllowedSource(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'ddnmgn.ru' || url.hostname.endsWith('.ddnmgn.ru'));
  } catch {
    return false;
  }
}

export async function extractSource(sourceUrl) {
  if (!isAllowedSource(sourceUrl)) {
    throw new Error('Укажите HTTPS-ссылку на страницу сайта ddnmgn.ru');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return await page.evaluate(() => {
      const absoluteUrl = value => {
        if (!value) return null;
        try { return new URL(value, location.href).href; } catch { return null; }
      };
      const unique = values => [...new Set(values.filter(Boolean))];
      const cleanText = value => value?.replace(/\s+/g, ' ').trim() || null;
      const text = selector => cleanText(document.querySelector(selector)?.textContent);
      const article = document.querySelector('.blog-full-post, article');
      const isVideoEmbed = value => /(?:youtube\.com|youtu\.be|rutube\.ru|vk\.com\/video|vkvideo\.ru)/i.test(value || '');
      const normalizeVideoUrl = value => {
        const url = absoluteUrl(value);
        if (!url) return null;
        try {
          const parsed = new URL(url);
          if (/^(?:www\.)?(?:vk\.com|vkvideo\.ru)$/i.test(parsed.hostname)
            && parsed.pathname.toLowerCase().endsWith('/video_ext.php')) {
            const ownerId = parsed.searchParams.get('oid');
            const videoId = parsed.searchParams.get('id');
            if (ownerId && videoId) return `https://vk.com/video${ownerId}_${videoId}`;
          }
        } catch {
          // absoluteUrl already validated the value; leave it unchanged if parsing fails here.
        }
        const rutubeEmbedMarker = '/play/embed/';
        const markerIndex = url.indexOf(rutubeEmbedMarker);
        if (markerIndex >= 0) {
          const nested = url.slice(markerIndex + rutubeEmbedMarker.length);
          if (/^https?:\/\//i.test(nested)) return nested.split('?')[0];
        }
        return url;
      };

      const normalizeHtml = node => {
        if (!node) return null;
        const clone = node.cloneNode(true);
        clone.querySelectorAll([
          'script',
          'style',
          'form',
          'iframe[src*="yandex"]',
          '.ya-share2',
          'textarea#text1',
          'button#speak',
          '#speak',
          'video',
          'iframe[src*="youtube.com"]',
          'iframe[src*="youtu.be"]',
          'iframe[src*="rutube.ru"]',
          'iframe[src*="vk.com/video"]',
          'iframe[src*="vkvideo.ru"]',
        ].join(', ')).forEach(item => item.remove());
        clone.querySelectorAll('*').forEach(item => {
          [...item.attributes].forEach(attribute => {
            if (attribute.name.toLowerCase().startsWith('on')) item.removeAttribute(attribute.name);
          });
        });
        clone.querySelectorAll('[src]').forEach(item => item.setAttribute('src', absoluteUrl(item.getAttribute('src'))));
        clone.querySelectorAll('a[href]').forEach(item => item.setAttribute('href', absoluteUrl(item.getAttribute('href'))));
        return clone.innerHTML.trim() || null;
      };

      const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map(node => {
          try { return JSON.parse(node.textContent); } catch { return null; }
        })
        .filter(Boolean);
      const graph = jsonLd.flatMap(value => value['@graph'] || [value]);
      const schemaArticle = graph.find(value => value?.['@type'] === 'Article') || null;
      const galleryLinks = [...document.querySelectorAll('section.photo a[href], .xfieldimagegallery a[href]')];
      const leadNode = article?.querySelector('.post-text[itemprop="description"]');
      const bodyNodes = article
        ? [...article.querySelectorAll(':scope > .post-text')].filter(node => node !== leadNode)
        : [];

      let pageContent = null;
      if (!article) {
        const preferred = document.querySelector('.page-content_block');
        if (preferred) pageContent = normalizeHtml(preferred);
        else if (document.querySelector('#rusday')) {
          const chunks = [];
          let sibling = document.querySelector('#rusday').nextElementSibling;
          while (sibling && !sibling.matches('footer, .footer, #footer')) {
            chunks.push(normalizeHtml(sibling));
            sibling = sibling.nextElementSibling;
          }
          pageContent = chunks.filter(Boolean).join('\n');
        }
      }

      const contentRoot = article || document.querySelector('.page-content_block, main') || document.body;
      const videoUrls = unique([
        ...[...contentRoot.querySelectorAll('video[src], video source[src]')].map(item => item.getAttribute('src')),
        ...[...contentRoot.querySelectorAll('iframe[src]')]
          .map(item => item.getAttribute('src'))
          .filter(isVideoEmbed),
        ...[...contentRoot.querySelectorAll('a[href]')]
          .map(item => item.getAttribute('href'))
          .filter(value => /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(value || '')),
      ].map(normalizeVideoUrl));
      const imageUrls = unique([
        document.querySelector('meta[property="og:image"]')?.content,
        article?.querySelector('[itemprop="image"]')?.getAttribute('src'),
        ...[...contentRoot.querySelectorAll('img')].map(img => img.currentSrc || img.src),
      ].map(absoluteUrl));
      const galleryUrls = unique(galleryLinks.map(link => absoluteUrl(link.getAttribute('href'))));
      const leadHtml = normalizeHtml(leadNode);
      const bodyHtml = bodyNodes.map(normalizeHtml).filter(Boolean).join('\n') || null;
      const description = cleanText(
        leadNode?.textContent
        || document.querySelector('meta[property="og:description"]')?.content
        || document.querySelector('meta[name="description"]')?.content,
      );
      const sourceDateText = cleanText(article?.querySelector('.post-info > span:first-child')?.textContent);
      const sourceDateMatch = sourceDateText?.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      const sourcePublishedAt = sourceDateMatch
        ? `${sourceDateMatch[3]}-${sourceDateMatch[2].padStart(2, '0')}-${sourceDateMatch[1].padStart(2, '0')}`
        : null;

      return {
        sourceUrl: location.href,
        kind: galleryUrls.length ? 'photo-album' : article ? 'article' : 'page',
        title: text('.blog-full-post h1[itemprop="name"], article h1, .page-content h1, #rusday h1, main h1')
          || document.querySelector('meta[property="og:title"]')?.content
          || document.title,
        description,
        annotation: description ? `${description.slice(0, 147).trim()}${description.length > 147 ? '…' : ''}` : null,
        leadHtml,
        bodyHtml,
        pageHtml: pageContent,
        contentHtml: [leadHtml, bodyHtml].filter(Boolean).join('\n') || pageContent,
        publishedAt: schemaArticle?.datePublished || sourcePublishedAt,
        modifiedAt: schemaArticle?.dateModified || null,
        author: schemaArticle?.author?.name || null,
        mainImageUrl: absoluteUrl(
          article?.querySelector('[itemprop="image"]')?.getAttribute('src')
          || document.querySelector('meta[property="og:image"]')?.content,
        ),
        imageUrls,
        galleryUrls,
        videoUrls,
      };
    });
  } finally {
    await browser.close();
  }
}
