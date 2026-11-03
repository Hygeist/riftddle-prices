// Adds today's TCGplayer prices to movers/price-history.jsonl, for movers.mjs to rank. Current prices can't rebuild this later.
// TCGCSV is a daily mirror of TCGplayer, refreshed around 20:00 UTC. Same reading as the site's scripts/fetch-prices.mjs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY = join(dirname(fileURLToPath(import.meta.url)), 'price-history.jsonl');
const BASE = 'https://tcgcsv.com/tcgplayer/89'; // Riftbound on TCGplayer
// TCGCSV's usage guidelines (https://tcgcsv.com/docs#usage-guidelines): name the app, sleep between requests, sync once a day.
const HEADERS = { 'User-Agent': 'RiftRiddle/0.1.0 (+https://riftddle.com)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (path) => {
  await sleep(100);
  const res = await fetch(`${BASE}/${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()).results;
};

const history = existsSync(HISTORY) ? readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean) : [];
const last = history.length ? JSON.parse(history.at(-1)) : undefined;

const res = await fetch('https://tcgcsv.com/last-updated.txt', { headers: HEADERS });
if (!res.ok) throw new Error(`last-updated.txt: HTTP ${res.status}`);
const updated = (await res.text()).trim();
if (last?.updated === updated) {
  console.log(`Already up to date (${updated}).`);
  process.exit(0);
}

const prices = {}; // productId: [normal market, normal low, foil market, foil low]
for (const g of await get('groups')) {
  const products = await get(`${g.groupId}/products`);
  const rows = await get(`${g.groupId}/prices`);
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.productId)) byId.set(row.productId, {});
    byId.get(row.productId)[row.subTypeName] = row;
  }
  for (const p of products) {
    const ext = Object.fromEntries((p.extendedData ?? []).map((e) => [e.name, e.value]));
    if (!ext.Number || !ext['Card Type'] || /Token/.test(ext['Card Type'])) continue; // Sealed product has neither.
    const row = byId.get(p.productId) ?? {};
    const day = [row.Normal?.marketPrice, row.Normal?.lowPrice, row.Foil?.marketPrice, row.Foil?.lowPrice].map((v) => v ?? null);
    if (day.some((v) => v !== null)) prices[p.productId] = day;
  }
}
if (!Object.keys(prices).length) throw new Error('No prices found.');

// One snapshot per day, dated by TCGCSV's refresh. A second refresh on the same UTC day replaces the first.
const date = updated.slice(0, 10);
if (last?.date === date) history.pop();
history.push(JSON.stringify({ date, updated, prices }));
writeFileSync(HISTORY, `${history.join('\n')}\n`);
console.log(`${Object.keys(prices).length} prices recorded for ${date}; ${history.length} days.`);
