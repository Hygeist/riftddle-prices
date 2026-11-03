// Tournament deck lists for the site's Decks tab, from TopDeck.gg's API into meta/decks.json. Run by .github/workflows/sync.yml.
// The rules: current set only (meta/sets.json), Constructed events of 250+ players, top 10, each Legend's best list per event, no identical lists.
// It asks once a day. Every other run only republishes the saved file, because sync.mjs rebuilds site/ each time.
// TopDeck's terms: show a visible credit and link beside the data, and don't sell it. Each list's note and source link carry the credit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SAVED = resolve(here, 'decks.json');
const OUT = process.argv.find((a) => a.endsWith('.json')) ?? resolve(here, '../site/tournament-decks.json');
const KEY = process.env.TOPDECK_API_KEY;

const MIN_PLAYERS = 250;
const TOP = 10;
const CHECK_EVERY = 20 * 3_600_000;
const ZONES = [['Legend', 'Legend'], ['Champion', 'Champion'], ['Mainboard', 'MainDeck'], ['Battlefields', 'Battlefields'], ['Runes', 'Runes'], ['Sideboard', 'Sideboard']];

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const slugOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 44);
const dayOf = (unix) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function currentSet(today) {
  const sets = JSON.parse(readFileSync(resolve(here, 'sets.json'), 'utf8')).sort((a, b) => a.from.localeCompare(b.from));
  const set = sets.findLast((s) => s.from <= today);
  if (!set) throw new Error('meta/sets.json has no released set');
  return set;
}

const cardsIn = (zone) => Object.entries(zone ?? {}).map(([name, c]) => [name, c.count]);
const listOf = (deck) => ZONES.filter(([zone]) => cardsIn(deck[zone]).length).map(([zone, title]) => `${title}:\n${cardsIn(deck[zone]).map(([n, c]) => `${c} ${n}`).join('\n')}`).join('\n');
/** The same cards in the same zones, whatever order they were entered in. */
const fingerprint = (deck) => ZONES.map(([zone]) => cardsIn(deck[zone]).map(([n, c]) => `${c} ${n}`).sort().join(',')).join('|');

async function fetchDecks(set) {
  const res = await fetch('https://topdeck.gg/api/v2/tournaments', {
    method: 'POST',
    headers: { Authorization: KEY, 'Content-Type': 'application/json', 'User-Agent': 'RiftRiddleMeta/1.0 (+https://riftddle.com)' },
    body: JSON.stringify({ game: 'Riftbound', format: 'Constructed', participantMin: MIN_PLAYERS, start: Math.floor(Date.parse(`${set.from}T00:00:00Z`) / 1000), end: Math.floor(Date.now() / 1000), columns: ['name', 'decklist', 'wins', 'draws', 'losses'] }),
  });
  if (!res.ok) throw new Error(`TopDeck: HTTP ${res.status}`);
  const events = (await res.json()).sort((a, b) => b.startDate - a.startDate);

  const seen = new Set();
  const legendsAt = new Set();
  const decks = [];
  // Best placings first, so an event keeps its best list of each Legend and a list two players shared stays with the higher one.
  const rows = events.flatMap((e) => (e.standings ?? []).slice(0, TOP).map((p, i) => ({ e, p, rank: i + 1 }))).sort((a, b) => a.rank - b.rank);
  for (const { e, p, rank } of rows) {
    const deck = p.deckObj;
    const legendName = Object.keys(deck?.Legend ?? {})[0];
    if (!legendName) continue;
    const legendAt = `${e.TID}|${legendName}`;
    if (legendsAt.has(legendAt)) continue;
    legendsAt.add(legendAt);
    const print = fingerprint(deck);
    if (seen.has(print)) continue;
    seen.add(print);
    const champion = legendName.split(',')[0].trim();
    const player = p.name && p.name !== 'Deleted User' ? p.name : 'Anonymous';
    decks.push({
      slug: `td-${slugOf(e.TID)}-${rank}`, name: `${player}'s ${champion}`, tier: 'Tournament', legend: champion, author: player,
      note: `${ordinal(rank)} of ${e.standings.length} at ${e.tournamentName} on ${dayOf(e.startDate)}, going ${p.wins}-${p.losses}-${p.draws}. Via TopDeck.gg.`,
      source: `https://topdeck.gg/event/${e.TID}`, sourceName: 'TopDeck.gg', list: listOf(deck),
    });
  }
  console.log(`TopDeck: ${events.length} events (${events.map((e) => e.tournamentName).join('; ')}), ${rows.length} top ${TOP} places, ${decks.length} unique lists.`);
  return { updated: new Date().toISOString(), set: set.name, decks };
}

const saved = existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, 'utf8')) : undefined;
let current = saved;
if (KEY && (!saved || Date.now() - Date.parse(saved.updated) >= CHECK_EVERY)) {
  try {
    current = await fetchDecks(currentSet(new Date().toISOString().slice(0, 10)));
    writeFileSync(SAVED, `${JSON.stringify(current)}\n`);
  } catch (e) {
    // The last good file stays up.
    console.error(e.message);
    process.exitCode = 1;
  }
} else {
  console.log(KEY ? `Deck lists checked ${saved.updated}: not due yet.` : 'No TOPDECK_API_KEY: keeping the saved deck lists.');
}
if (current) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(current));
}
