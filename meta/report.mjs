// Builds the site's Meta report from zero.gg's public pages into meta/report.json. Run by .github/workflows/sync.yml, or by hand with --force.
// It asks once a week, slowly. Every other run only republishes the saved report, because sync.mjs rebuilds site/ each time.
// The rules: current set only, main events of 250+ players, month reports add up from the start of the set, and a new set starts from nothing.
// zero.gg sends its data inside the page as JavaScript objects, so this looks for the flat records by their first field.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPORT = resolve(here, 'report.json');
const OUT = process.argv.find((a) => a.endsWith('.json')) ?? resolve(here, '../site/meta.json');
const FORCE = process.argv.includes('--force');

const SITE = 'https://www.zero.gg/riftbound';
const AGENT = 'RiftRiddleMeta/1.0 (+https://riftddle.com)';
const MIN_PLAYERS = 250;
const WEEK = 7 * 86_400_000;
/** Checked a little under a week apart, so the hourly schedule can't slide later each week. */
const CHECK_EVERY = WEEK - 12 * 3_600_000;
/** Standings can still be corrected just after an event, so recent ones are read again. */
const SETTLES_AFTER = 14 * 86_400_000;
/** Limited and team events, and the side events at a Regional Qualifier ("Regional Rebound - RQ Hartford"). */
const SIDE_EVENT = /sealed|draft|2v2|\bRQ\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(3000 + Math.random() * 3000);

async function page(path) {
  const res = await fetch(`${SITE}${path}`, { headers: { 'User-Agent': AGENT } });
  if (!res.ok) throw new Error(`zero.gg ${path}: HTTP ${res.status}`);
  return res.text();
}

const field = (record, name) => new RegExp(`[{,]${name}:("(?:[^"\\\\]|\\\\.)*"|-?[\\d.]+)`).exec(record)?.[1];
const count = (record, name) => Number(field(record, name) ?? 0);
function text(record, name) {
  const raw = field(record, name);
  if (!raw) return '';
  try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
}
const bare = (legend) => legend.replace(/ - Starter$/, '');

/** The newest set that has released, and the one after it. Dates are ours, from Riot's roadmap, in meta/sets.json. */
function setsOn(today) {
  const sets = JSON.parse(readFileSync(resolve(here, 'sets.json'), 'utf8')).sort((a, b) => a.from.localeCompare(b.from));
  const at = sets.findLastIndex((s) => s.from <= today);
  if (at < 0) throw new Error('meta/sets.json has no released set');
  return { set: sets[at], next: sets[at + 1] };
}

function legendsByEvent(html) {
  const marks = [...html.matchAll(/eventId:(\d+),eventName:"/g)];
  return new Map(marks.map((m, i) => {
    const part = html.slice(m.index, marks[i + 1]?.index);
    const legends = (part.match(/\{bestRank:[^{}]*\}/g) ?? []).map((r) => ({
      name: bare(text(r, 'name')), pilots: count(r, 'pilots'), wins: count(r, 'wins'), losses: count(r, 'losses'), draws: count(r, 'draws'), top8: count(r, 'top8'), bestRank: count(r, 'bestRank'),
    }));
    return [Number(m[1]), legends];
  }));
}

function eventsIn(list, overrides, from) {
  const side = new Set((overrides.match(/\{_creationTime:[^{}]*kind:"side"[^{}]*\}/g) ?? []).map((r) => count(r, 'uvsEventId')));
  const seen = new Set();
  return (list.match(/\{_creationTime:[^{}]*\}/g) ?? []).flatMap((r) => {
    const id = count(r, 'eventId');
    const name = text(r, 'name');
    const players = count(r, 'startingPlayerCount');
    const date = text(r, 'startDatetime').slice(0, 10);
    if (!id || seen.has(id) || players < MIN_PLAYERS || side.has(id) || SIDE_EVENT.test(name) || text(r, 'displayStatus') !== 'EVENT_FINISHED' || date < from) return [];
    seen.add(id);
    return [{ id, name, date, players }];
  });
}

async function standings(id) {
  const html = await page(`/events/${id}/standings`);
  const rows = new Map();
  for (const r of html.match(/\{[^{}]*playerName:[^{}]*\}/g) ?? []) {
    const rank = count(r, 'rank');
    if (rank >= 1 && rank <= 10 && !rows.has(rank)) rows.set(rank, { rank, player: text(r, 'playerName'), legend: bare(text(r, 'leader')), record: text(r, 'record') });
  }
  return [...rows.values()].sort((a, b) => a.rank - b.rank);
}

/** Every Legend's numbers added up over these events. A Starter printing counts with its Legend. */
function addUp(events) {
  const all = new Map();
  for (const e of events) {
    for (const l of e.legends ?? []) {
      const sum = all.get(l.name) ?? { name: l.name, pilots: 0, wins: 0, losses: 0, draws: 0, top8: 0, eventWins: 0 };
      sum.pilots += l.pilots; sum.wins += l.wins; sum.losses += l.losses; sum.draws += l.draws; sum.top8 += l.top8;
      if (l.bestRank === 1) sum.eventWins++;
      all.set(l.name, sum);
    }
  }
  return [...all.values()].sort((a, b) => b.pilots - a.pilots);
}

const report = (label, through, events) => ({ label, through, events: events.length, players: events.reduce((n, e) => n + e.players, 0), legends: addUp(events) });

/** One report per finished month, each carrying the months before it. */
function monthReports(events, today) {
  const thisMonth = today.slice(0, 7);
  const months = [...new Set(events.map((e) => e.date.slice(0, 7)))].filter((m) => m < thisMonth).sort();
  return months.map((m) => report(m, m, events.filter((e) => e.date.slice(0, 7) <= m && e.legends?.length))).reverse();
}

async function refresh(saved) {
  const today = new Date().toISOString().slice(0, 10);
  const listPage = await page('/events');
  await pause();
  const metaPage = await page('/meta');
  const { set, next } = setsOn(today);
  if (saved && saved.set.name !== set.name) console.log(`New set: ${saved.set.name} to ${set.name}. Starting the meta again.`);

  const known = new Map((saved?.events ?? []).filter((e) => e.date >= set.from).map((e) => [e.id, e]));
  const legends = legendsByEvent(metaPage);
  const found = eventsIn(listPage, metaPage, set.from);
  for (const e of found) known.set(e.id, { ...known.get(e.id), ...e });
  const events = [...known.values()].sort((a, b) => b.date.localeCompare(a.date) || b.players - a.players);
  // A brand new set can have no events yet, but a page with no events at all means zero.gg changed.
  if (!/\{_creationTime:[^{}]*eventId:/.test(listPage)) throw new Error('zero.gg gave no events, so the old report stays');

  for (const e of events) {
    const fresh = legends.get(e.id);
    if (fresh?.length) e.legends = fresh;
    if (e.top?.length && Date.parse(e.date) < Date.now() - SETTLES_AFTER) continue;
    await pause();
    const top = await standings(e.id);
    if (top.length) e.top = top; else console.log(`No standings yet for ${e.name}`);
  }

  const months = monthReports(events, today);
  const now = new Date().toISOString();
  return {
    updated: now, source: 'zero.gg', minPlayers: MIN_PLAYERS, set, next, months,
    soFar: months.length ? undefined : report('so far', today.slice(0, 7), events.filter((e) => e.legends?.length)),
    events,
  };
}

const saved = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : undefined;
let current = saved;
let failure;
if (FORCE || !saved || Date.now() - Date.parse(saved.updated) >= CHECK_EVERY) {
  try {
    current = await refresh(saved);
    writeFileSync(REPORT, `${JSON.stringify(current)}\n`);
    console.log(`Meta report: ${current.set.name}, ${current.events.length} events, ${current.months.length} month reports.`);
  } catch (e) {
    failure = e;
    console.error(e.message);
  }
} else {
  console.log(`Meta report checked ${saved.updated}: not due yet.`);
}
if (current) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(current));
}
if (failure) process.exitCode = 1;
