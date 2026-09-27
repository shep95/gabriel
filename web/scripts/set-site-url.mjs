// writes the absolute site url into the places crawlers need it:
// canonical + og:url in index.html, and sitemap.xml. run once per domain:
//   node web/scripts/set-site-url.mjs https://your-domain.example
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(site)) {
  console.error('usage: node set-site-url.mjs https://your-domain.example');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const put = (re, line) => { html = re.test(html) ? html.replace(re, line) : html.replace('</head>', `  ${line}\n</head>`); };
put(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${site}/">`);
put(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${site}/">`);
put(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${site}/icons/og.png">`);
put(/<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="${site}/icons/og.png">`);
html = html.replace(/"url": "https?:\/\/[^"]*"/, `"url": "${site}/"`);
fs.writeFileSync(indexPath, html);
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(root, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${site}/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>1.0</priority></url>
</urlset>
`);
let robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8').replace(/\nSitemap: .*\n?/g, '\n');
fs.writeFileSync(path.join(root, 'robots.txt'), `${robots.trimEnd()}\nSitemap: ${site}/sitemap.xml\n`);
console.log('site url set to', site);
