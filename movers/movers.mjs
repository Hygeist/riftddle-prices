// Ranks the week's price moves from movers/price-history.jsonl into site/movers.json. Run by .github/workflows/sync.yml. Copy of the site's scripts/movers.mjs.
// Each card's price is its cheapest listing on TCGplayer US, in its cheaper finish, compared with about 7 days earlier.
// Paths can be passed in, to try it on other data: node scripts/movers.mjs <history> <cards> <out>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HISTORY = process.argv[2] ?? resolve(here, 'data/price-history.jsonl');
const CARDS = process.argv[3] ?? resolve(here, '../public/data/cards.json');
const OUT = process.argv[4] ?? resolve(here, '../public/data/movers.json');

const WEEK = 7;
const MAX_AGE = 10; // Days. A missed run can push the comparison back this far, but never closer than a week.
const MIN_PRICE = 2; // A card has to reach this at one end of the week, or its percentages are only noise.
const MAX_RATIO = 3; // Tripling or falling to a third in a week is more likely a bad listing than a real move.
const MAX_LOW_GAP = 2; // The cheapest listing more than this far from market price is held out as a bad listing.
const TOP = 30;
const SPARK_DAYS = 31;

const DAY = 86_400_000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

const snapshots = existsSync(HISTORY)
  ? readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.date.localeCompare(b.date))
  : [];
const known = new Set(JSON.parse(readFileSync(CARDS, 'utf8')).cards.map((c) => c.id));

/** The cheaper finish that has a listing, as { finish, low, market }. */
function basis(day) {
  if (!day) return undefined;
  const [normalMarket, normalLow, foilMarket, foilLow] = day;
  if (normalLow > 0 && !(foilLow > 0 && foilLow < normalLow)) return { finish: 'normal', low: normalLow, market: normalMarket };
  return foilLow > 0 ? { finish: 'foil', low: foilLow, market: foilMarket } : undefined;
}

const offMarket = (b) => b.market > 0 && (b.low / b.market > MAX_LOW_GAP || b.market / b.low > MAX_LOW_GAP);

const latest = snapshots.at(-1);
const first = snapshots[0];
// The newest snapshot at least a week old, if it isn't too old to call "a week".
const baseline = latest && snapshots.findLast((s) => daysBetween(s.date, latest.date) >= WEEK);
const usable = baseline && daysBetween(baseline.date, latest.date) <= MAX_AGE ? baseline : undefined;

const result = {
  latest: latest?.date,
  updated: latest?.updated,
  first: first?.date,
  days: snapshots.length,
  span: latest ? daysBetween(first.date, latest.date) : 0,
  week: WEEK,
  maxAge: MAX_AGE,
  minPrice: MIN_PRICE,
  maxRatio: MAX_RATIO,
};

if (usable) {
  const held = { noListing: 0, basisChanged: 0, cheap: 0, outlier: 0 };
  const moves = [];
  for (const [key, day] of Object.entries(latest.prices)) {
    const id = Number(key);
    if (!known.has(id)) continue;
    const now = basis(day);
    const then = basis(usable.prices[key]);
    if (!now || !then) { held.noListing++; continue; }
    if (now.finish !== then.finish) { held.basisChanged++; continue; }
    if (Math.max(now.low, then.low) < MIN_PRICE) { held.cheap++; continue; }
    const ratio = now.low / then.low;
    if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO || offMarket(now) || offMarket(then)) { held.outlier++; continue; }
    moves.push({ id, finish: now.finish, then: then.low, now: now.low, pct: Math.round((ratio - 1) * 1000) / 10 });
  }
  const moved = moves.filter((m) => m.now !== m.then);
  // A card's graph: its cheapest listing in this finish, day by day, over the last SPARK_DAYS snapshots.
  const recent = snapshots.slice(-SPARK_DAYS);
  const sparkOf = (m) => recent.map((s) => s.prices[m.id]?.[m.finish === 'normal' ? 1 : 3] ?? null);
  // Furthest below its high, ignoring highs too far off to be anything but a bad listing.
  const value = moves.filter((m) => m.now >= MIN_PRICE).flatMap((m) => {
    const high = Math.max(...sparkOf(m).filter((v) => v !== null));
    return high > m.now && high / m.now <= MAX_RATIO ? [{ ...m, high, pct: Math.round((m.now / high - 1) * 1000) / 10 }] : [];
  });
  const withSpark = (list) => list.map((m) => ({ ...m, spark: sparkOf(m) }));
  result.baseline = usable.date;
  result.compared = moves.length;
  result.held = held;
  result.sparkDates = recent.map((s) => s.date);
  result.risers = withSpark(moved.filter((m) => m.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, TOP));
  result.drops = withSpark(moved.filter((m) => m.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, TOP));
  result.value = withSpark(value.sort((a, b) => a.pct - b.pct).slice(0, TOP));
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result));
console.log(usable
  ? `Movers: ${latest.date} vs ${usable.date}, ${result.compared} compared, ${result.risers.length} risers, ${result.drops.length} drops, held out ${JSON.stringify(result.held)}.`
  : `Movers: no comparison yet. ${snapshots.length} snapshot(s) covering ${result.span} of ${WEEK} days.`);
