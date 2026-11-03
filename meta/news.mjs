// Riot's new announcements for the site's News tab, from the data in playriftbound.com's news page into meta/news.json. Run by .github/workflows/sync.yml.
// Headlines only: title, date, category, image and a link back. No article text is copied, and TL;DRs stay hand-written in the site's news.json.
// It asks once a day. Every other run only republishes the saved file, because sync.mjs rebuilds site/ each time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SAVED = resolve(here, 'news.json');
const OUT = process.argv.find((a) => a.endsWith('.json')) ?? resolve(here, '../site/riot-news.json');

const PAGE = 'https://playriftbound.com/en-us/news/';
const CHECK_EVERY = 20 * 3_600_000;
// The site's own news.json covers Riot's posts back to here. Older posts stay off the News tab.
const FROM = '2026-10-15';

/** The page's list of articles, found by its shape so a moved section doesn't break it. */
function articlesIn(node) {
  if (Array.isArray(node) && node[0]?.publishedAt && node[0]?.title) return node;
  if (!node || typeof node !== 'object') return undefined;
  for (const child of Object.values(node)) {
    const found = articlesIn(child);
    if (found) return found;
  }
  return undefined;
}

function itemOf(a) {
  const url = a.action?.payload?.url && new URL(a.action.payload.url, PAGE);
  if (url?.protocol !== 'https:' || !a.media?.url) return undefined;
  const video = /(^|\.)(youtube\.com|youtu\.be)$/.test(url.hostname);
  const last = url.searchParams.get('v') ?? url.pathname.split('/').filter(Boolean).pop();
  return { slug: `riot-${last}`, title: a.title, date: a.publishedAt.slice(0, 10), category: a.category?.title ?? 'Announcements', url: url.href, ...(video ? { video } : {}), image: a.media.url, tldr: '', points: [] };
}

async function fetchNews() {
  const res = await fetch(PAGE, { headers: { 'User-Agent': 'RiftRiddleNews/1.0 (+https://riftddle.com)' } });
  if (!res.ok) throw new Error(`Riot news: HTTP ${res.status}`);
  const data = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(await res.text())?.[1];
  const articles = data && articlesIn(JSON.parse(data));
  if (!articles) throw new Error('Riot news: no article list in the page');
  const items = articles.map(itemOf).filter((n) => n && n.date >= FROM);
  console.log(`Riot news: ${articles.length} on the page, ${items.length} since ${FROM}.`);
  return { updated: new Date().toISOString(), items };
}

const saved = existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, 'utf8')) : undefined;
let current = saved;
if (!saved || Date.now() - Date.parse(saved.updated) >= CHECK_EVERY) {
  try {
    current = await fetchNews();
    writeFileSync(SAVED, `${JSON.stringify(current)}\n`);
  } catch (e) {
    // The last good file stays up.
    console.error(e.message);
    process.exitCode = 1;
  }
} else {
  console.log(`Riot news checked ${saved.updated}: not due yet.`);
}
if (current) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(current.items));
}
