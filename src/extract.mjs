import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACTS_DIR } from './config.mjs';
import { extractSource } from './lib/source.mjs';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Передайте хотя бы один URL страницы ddnmgn.ru.');
  process.exit(1);
}

await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
const results = [];

for (const url of urls) {
  const item = await extractSource(url);
  results.push(item);
  console.log(`- ${item.kind}: ${item.title}; изображений: ${item.imageUrls.length}; фото галереи: ${item.galleryUrls.length}`);
}

const outputPath = path.join(ARTIFACTS_DIR, 'extracted.json');
await fs.writeFile(outputPath, JSON.stringify(results, null, 2), 'utf8');
console.log(`Извлечено страниц: ${results.length}`);
console.log(`Результат: ${outputPath}`);
