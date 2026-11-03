// Pulls Riftbound listings from each store in stores.json, matches them to cards, and writes one small JSON per card to site/ for GitHub Pages.
// Run by .github/workflows/sync.yml every 30 minutes. `node sync.mjs [domain ...]` runs only those stores.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = join(here, 'site');
const STATE = join(here, 'state', 'listings.json');
const CARDS_URL = 'https://riftddle.1cshen.workers.dev/data/cards.json'; // riftddle.com's Cloudflare rules answer GitHub's runners with 403.
const HEADERS = { 'User-Agent': 'RiftRiddlePriceCheck/1.0 (+https://riftddle.com)', Accept: 'application/json' };
const AT_ONCE = 4; // Shopify limits by IP across shops, so more than this gets runners 429s.
const PAUSE_MS = 800; // Between requests to the same store.
const BUDGET_MS = 20 * 60 * 1000; // Stop starting stores after this; the next run picks up the oldest first.
const MAX_PAGES = 40; // Per store, so one huge catalogue can't hold up the run.
const KEEP_FAILED_MS = 24 * 3600 * 1000; // A store that fails keeps its last listings this long.

const REGION_CURRENCY = { US: 'USD', CA: 'CAD', GB: 'GBP', EU: 'EUR', AU: 'AUD', SG: 'SGD' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function getJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (r.status === 429) { await sleep(30000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  throw new Error('HTTP 429');
}

// ---- Reading a listing ----

const SET_NAMES = [
  [/proving grounds/i, 'OGS'], [/organized play/i, 'OPP'], [/judge/i, 'JDG'], [/worlds bundle/i, 'RWB'], [/t1 /i, 'T12025'], [/secret garden/i, 'SGN'],
  [/promotional/i, 'PR'], [/radiance/i, 'RAD'], [/vendetta/i, 'VEN'], [/unleashed/i, 'UNL'], [/spiritforged/i, 'SFD'], [/origins/i, 'OGN'],
];
const NOT_A_SINGLE = /\b(booster|display|box|pack|bundle|binder|portfolio|sleeves?|playmat|deck box|tin|lot|bulk|sealed|case|pre-?order|locals|nexus nights|ticket|entry)\b/i;
const OTHER_LANGUAGE = /\b(chinese|korean|japanese|french|german|spanish|italian|portuguese)\b|\[?\b(cn|kr|jp)\b\]?/i;
const GRADED = /\b(psa|bgs|cgc|graded|slab)\b/i;

export function readNumber(title) {
  const m = title.match(/(?:^|[^\w/])(\d{1,3}[a-z]?\*?)\s*\/\s*(\d{2,3})\b/);
  if (m) {
    const star = m[1].endsWith('*') || /signature/i.test(title) ? '*' : '';
    const body = m[1].replace('*', '');
    const digits = body.match(/\d+/)[0];
    return `${digits.padStart(3, '0')}${body.slice(digits.length)}${star}/${m[2]}`;
  }
  return title.match(/\bR0\d[ab]?\b/)?.[0];
}

export function readSet(title) {
  const code = title.match(/\[([A-Z0-9]{2,6})\s*-/)?.[1];
  if (code) return code;
  for (const [re, set] of SET_NAMES) if (re.test(title)) return set;
  return undefined;
}

function readCondition(text) {
  if (/\b(near mint|nm)\b/i.test(text)) return 'NM';
  if (/\b(lightly|slightly) played\b|\b(lp|sp)\b/i.test(text)) return 'LP';
  if (/\bmoderately played\b|\bmp\b/i.test(text)) return 'MP';
  if (/\bheavily played\b|\bhp\b/i.test(text)) return 'HP';
  if (/\bdamaged\b|\bdmg\b/i.test(text)) return 'DMG';
  return 'NM';
}

function readFinish(variant, title, card) {
  if (/\bnon[- ]?foil\b|\bnormal\b/i.test(variant)) return 'n';
  if (/\bfoil\b/i.test(variant)) return 'f';
  if (/\bnon[- ]?foil\b/i.test(title)) return 'n';
  if (/\bfoil\b/i.test(title)) return 'f';
  return card.normal === undefined && card.foil !== undefined ? 'f' : 'n';
}

// ---- Matching a listing to a card ----

function buildIndex(cards) {
  const byNo = new Map();
  const byName = new Map();
  for (const c of cards) {
    if (!byNo.has(c.no)) byNo.set(c.no, []);
    byNo.get(c.no).push(c);
    const k = key(c.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  return { byNo, byName };
}

const PROMO_SETS = new Set(['OPP', 'PR', 'JDG', 'RWB', 'T12025', 'SGN']);

export function matchCard(title, index) {
  const titleKey = key(title);
  const no = readNumber(title);
  if (no) {
    let found = (index.byNo.get(no) ?? []).filter((c) => titleKey.includes(key(c.name)));
    if (!found.length) return undefined;
    const set = readSet(title);
    if (set) found = found.filter((c) => c.set === set);
    else if (found.length > 1) found = found.filter((c) => !PROMO_SETS.has(c.set));
    if (found.length > 1) {
      const worded = found.filter((c) => c.variant && titleKey.includes(key(c.variant)));
      found = worded.length ? worded : found.filter((c) => !c.variant);
    }
    return found.length === 1 ? found[0] : undefined;
  }
  // No number: only safe when the card has one printing and the title is little more than its name.
  const clean = key(title.replace(/\(.*?\)|\[.*?\]|\bfoil\b|\bnon[- ]?foil\b|riftbound|league of legends/gi, ''));
  const same = index.byName.get(clean);
  return same?.length === 1 ? same[0] : undefined;
}

/** A market price far from the store's means the match is probably wrong (or a store's typo). */
function sane(price, card, finish) {
  const market = finish === 'f' ? card.foil : card.normal;
  if (market === undefined) return true;
  if (market >= 5 && price < market * 0.1) return false;
  if (price >= 50 && price > market * 20) return false;
  return true;
}

// ---- Fetching a store ----

const SKIP_COLLECTION = /new|restock|sealed|pre-?order|booster|supplies|accessor|arrival/i;

async function riftboundCollections(domain) {
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const { collections = [] } = await getJson(`https://${domain}/collections.json?limit=250&page=${page}`);
    all.push(...collections);
    if (collections.length < 250) break;
    await sleep(PAUSE_MS);
  }
  return all
    .filter((c) => /riftbound/i.test(`${c.title} ${c.handle}`) && !SKIP_COLLECTION.test(c.handle) && c.products_count !== 0)
    .sort((a, b) => (b.products_count ?? 0) - (a.products_count ?? 0))
    .slice(0, 6);
}

async function fetchProducts(domain) {
  const seen = new Map();
  let budget = MAX_PAGES;
  const collections = await riftboundCollections(domain);
  const paths = collections.length ? collections.map((c) => `collections/${c.handle}/products.json`) : ['collections/all/products.json'];
  for (const path of paths) {
    for (let page = 1; budget > 0; page++, budget--) {
      await sleep(PAUSE_MS);
      const { products = [] } = await getJson(`https://${domain}/${path}?limit=250&page=${page}`);
      for (const p of products) seen.set(p.id, p);
      if (products.length < 250) break;
    }
  }
  return [...seen.values()];
}

function listingsFrom(products, store, index, review) {
  const best = new Map();
  for (const p of products) {
    const about = `${p.title} ${p.product_type ?? ''} ${p.vendor ?? ''}`;
    if (NOT_A_SINGLE.test(p.title) || OTHER_LANGUAGE.test(p.title) || GRADED.test(p.title)) continue;
    const card = matchCard(p.title, index);
    if (!card) {
      if (/riftbound/i.test(about) || (p.tags ?? []).some?.((t) => /riftbound/i.test(t))) review.push(`${store.domain}: ${p.title}`);
      continue;
    }
    for (const v of p.variants ?? []) {
      if (!v.available || OTHER_LANGUAGE.test(v.title ?? '') || GRADED.test(v.title ?? '')) continue;
      const price = Number(v.price);
      if (!(price > 0)) continue;
      const finish = readFinish(v.title ?? '', p.title, card);
      if (!sane(price, card, finish)) { review.push(`${store.domain}: price ${price} looks wrong: ${p.title}`); continue; }
      const cond = readCondition(v.title ?? '');
      const row = { id: card.id, f: finish, p: price, q: cond, h: p.handle, v: v.id };
      const k = `${card.id}|${finish}`;
      const old = best.get(k);
      // Cheapest Near Mint wins; played copies only show where there is no Near Mint.
      if (!old || (cond === 'NM' && old.q !== 'NM') || (cond === old.q && price < old.p) || (cond !== 'NM' && old.q !== 'NM' && price < old.p)) best.set(k, row);
    }
  }
  return [...best.values()];
}

// ---- The run ----

async function main() {
  const db = await fetch(CARDS_URL, { headers: HEADERS }).then((r) => { if (!r.ok) throw new Error(`cards.json: HTTP ${r.status}`); return r.json(); });
  const index = buildIndex(db.cards);
  const only = process.argv.slice(2);
  const stores = JSON.parse(readFileSync(join(here, 'stores.json'), 'utf8')).filter((s) => !only.length || only.includes(s.domain));
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  stores.sort((a, b) => (state[a.domain]?.t ?? 0) - (state[b.domain]?.t ?? 0));
  const now = Date.now();
  const report = [];
  const review = [];

  let next = 0;
  await Promise.all(Array.from({ length: AT_ONCE }, async () => {
    while (next < stores.length && Date.now() - now < BUDGET_MS) {
      const store = stores[next++];
      try {
        const products = await fetchProducts(store.domain);
        const rows = listingsFrom(products, store, index, review);
        state[store.domain] = { t: now, rows };
        report.push({ domain: store.domain, ok: true, products: products.length, listings: rows.length });
      } catch (e) {
        report.push({ domain: store.domain, ok: false, error: String(e.message ?? e) });
        if (state[store.domain] && now - state[store.domain].t > KEEP_FAILED_MS) delete state[store.domain];
      }
    }
  }));

  // One file per card, so the popup downloads only what it shows.
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, 'cards'), { recursive: true });
  const allStores = JSON.parse(readFileSync(join(here, 'stores.json'), 'utf8'));
  const perCard = new Map();
  for (const s of allStores) {
    const held = state[s.domain];
    if (!held) continue;
    for (const r of held.rows) {
      if (!perCard.has(r.id)) perCard.set(r.id, []);
      perCard.get(r.id).push({ s: s.name, d: s.domain, r: s.regions, c: s.currency, f: r.f, p: r.p, q: r.q, h: r.h, v: r.v, t: held.t });
    }
  }
  for (const [id, listings] of perCard) writeFileSync(join(SITE, 'cards', `${id}.json`), JSON.stringify({ updated: now, listings }));
  // The Builder's prices: each card's cheapest near-mint copy per region, in that region's currency, so one file prices a whole deck.
  const lows = {};
  for (const [id, listings] of perCard) {
    for (const l of listings) {
      if (l.q !== 'NM') continue;
      for (const region of l.r) {
        if (l.c !== REGION_CURRENCY[region]) continue;
        const slot = (lows[id] ??= {});
        if (slot[region] === undefined || l.p < slot[region]) slot[region] = l.p;
      }
    }
  }
  writeFileSync(join(SITE, 'lows.json'), JSON.stringify({ updated: now, lows }));
  const ok = report.filter((r) => r.ok);
  writeFileSync(join(SITE, 'status.json'), JSON.stringify({ updated: now, stores: allStores.length, ok: ok.length, cards: perCard.size, report: report.sort((a, b) => a.domain.localeCompare(b.domain)) }));
  writeFileSync(join(SITE, 'review.json'), JSON.stringify(review.slice(0, 5000), null, 0));
  writeFileSync(join(SITE, 'index.html'), '<!doctype html><title>RiftRiddle store prices</title><p>Data files for <a href="https://riftddle.com">riftddle.com</a>.</p>');

  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state));
  writeHistory(perCard, now);

  console.log(`${ok.length}/${stores.length} stores ok, ${perCard.size}/${db.cards.length} cards with listings, ${report.reduce((n, r) => n + (r.listings ?? 0), 0)} listings, ${review.length} for review`);
  for (const r of report.filter((x) => !x.ok)) console.log(`failed ${r.domain}: ${r.error}`);
}

/** The first run of each UTC day records the lowest price per card, finish and currency. Current prices can't rebuild this later. */
function writeHistory(perCard, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const file = join(here, 'history', `${day}.json`);
  if (existsSync(file)) return;
  const low = {};
  for (const [id, listings] of perCard) {
    for (const l of listings) {
      if (l.q !== 'NM') continue;
      const slot = ((low[id] ??= {})[l.c] ??= {});
      if (slot[l.f] === undefined || l.p < slot[l.f]) slot[l.f] = l.p;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(low));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
