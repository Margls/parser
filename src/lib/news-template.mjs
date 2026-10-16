function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function withoutImages(html) {
  // All images used in the new publication are uploaded to EISRF first.  Do
  // not leave links to the old site in the article body.
  return String(html || '')
    .replace(/<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .trim();
}

export function buildNewsHtml({ source, previewImageUrl, videoHtml = '' }) {
  const title = escapeHtml(source.title);
  const annotation = source.description || source.annotation || '';
  const body = withoutImages(source.bodyHtml || source.pageHtml || source.contentHtml);
  const hero = previewImageUrl ? `
  <div style="margin:0 0 25px;">
    <img src="${escapeHtml(previewImageUrl)}" alt="${title}" style="display:block;width:100%;height:auto;border:0;border-radius:3px;">
  </div>` : '';
  const quote = annotation ? `
  <div style="background:#f6f3ee;border-left:4px solid #a21e3d;padding:22px 25px;margin:27px 0 30px;">
    <p style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.5;color:#19233d;margin:0;">${escapeHtml(annotation)}</p>
  </div>` : '';

  return `<div style="max-width:900px;margin:0 auto;padding:12px 0 42px;color:#19233d;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:1.75;">
  <div style="border-top:3px solid #a21e3d;padding-top:20px;margin-bottom:25px;">
    <p style="margin:0 0 14px;font-size:12px;line-height:1.5;letter-spacing:2px;text-transform:uppercase;font-weight:bold;color:#a21e3d;">Из жизни Дома дружбы народов <span style="color:#a5aab5;">&nbsp; / &nbsp; Новости</span></p>
    <p style="margin:0 0 13px;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.25;color:#19233d;font-weight:normal;">${title}</p>
  </div>${hero}${quote}
  <div style="margin:0 0 26px;">${body}</div>
  ${videoHtml}
</div>`;
}
