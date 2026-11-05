// Player history: the top 8 of every main event of 250+ players on zero.gg, from every set. Unlike report.json it never starts over.
// The first run reads every event once, slowly. After that only events it hasn't seen are read, plus recent ones whose standings may still change.
// Writes meta/players.json (kept in the repo) and site/players.json for the site's #meta tab. Run by .github/workflows/sync.yml, or by hand.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsIn, page, pause, standings } from './zero.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAVED = resolve(here, 'players.json');
const OUT = process.argv.find((a) => a.endsWith('.json')) ?? resolve(here, '../site/players.json');
const TOP = 8;
/** Standings can still be corrected just after an event, so recent ones are read again. */
const SETTLES_AFTER = 14 * 86_400_000;

/** Which set an event was played in, by our own set dates. Events before the first listed set are "Earlier". */
function setOf(date) {
  const sets = JSON.parse(readFileSync(resolve(here, 'sets.json'), 'utf8')).sort((a, b) => a.from.localeCompare(b.from));
  return sets.findLast((s) => s.from <= date)?.name ?? 'Earlier';
}

const saved = existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, 'utf8')) : { events: [] };
const known = new Map(saved.events.map((e) => [e.id, e]));
let asked = 0;
let failure;

try {
  const list = await page('/events');
  await pause();
  const marks = await page('/meta');
  for (const e of eventsIn(list, marks, '0000')) {
    const old = known.get(e.id);
    if (old?.top?.length && Date.parse(e.date) < Date.now() - SETTLES_AFTER) continue;
    await pause();
    asked++;
    const top = await standings(e.id, TOP);
    if (top.length) known.set(e.id, { ...e, set: setOf(e.date), top });
    else console.log(`No standings yet for ${e.name}`);
  }
} catch (e) {
  failure = e;
  console.error(e.message);
}

const events = [...known.values()].sort((a, b) => b.date.localeCompare(a.date) || b.players - a.players);
const current = { updated: asked ? new Date().toISOString() : saved.updated ?? new Date().toISOString(), source: 'zero.gg', top: TOP, events };
if (asked) writeFileSync(SAVED, `${JSON.stringify(current)}\n`);
console.log(`Player history: ${events.length} events, ${asked} read from zero.gg this run.`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(current));
if (failure) process.exitCode = 1;
