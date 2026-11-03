// A basic News tile for each big event in the Meta report, from meta/report.json into meta/tournament-news.json. Run by .github/workflows/sync.yml, after report.mjs.
// It asks nobody but our own card data: usage is node meta/tournament-news.mjs <cards.json> [out.json].
// report.json starts empty at a new set, so past tiles stay in the saved file. A hand-written story with the same standings link replaces its tile on the site.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SAVED = resolve(here, 'tournament-news.json');
const [, , CARDS, OUT = resolve(here, '../site/tournament-news.json')] = process.argv;

const TOP = 8;
const CDN = 'https://tcgplayer-cdn.tcgplayer.com/product';

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** zero.gg names a Legend by its subtitle ("The Exile"). The first printing gives the champion and the art. */
function legendsIn(cards) {
  const legends = new Map();
  for (const c of cards) {
    const [champion, ...rest] = c.name.split(', ');
    const subtitle = rest.join(', ');
    if (c.type === 'Legend' && !legends.has(subtitle)) legends.set(subtitle, { champion, image: typeof c.art === 'string' ? c.art : `${CDN}/${c.art ?? c.id}_in_1000x1000.jpg` });
  }
  return legends;
}

function tileOf(e, legends) {
  const champion = (subtitle) => legends.get(subtitle)?.champion ?? subtitle;
  const [winner, second] = e.top;
  const won = champion(winner.legend);
  const counts = new Map();
  for (const p of e.top.filter((t) => t.rank <= TOP)) counts.set(champion(p.legend), (counts.get(champion(p.legend)) ?? 0) + 1);
  const share = counts.get(won);
  return {
    slug: `event-${e.id}`, title: `${e.name.replace(/(\S)- /, '$1 - ')}: ${won} wins`, date: e.date, category: 'Tournament', url: `https://zero.gg/riftbound/events/${e.id}/standings`,
    image: legends.get(winner.legend)?.image ?? '',
    tldr: `${e.players} players. ${winner.player} won on ${won} at ${winner.record}${share > 1 ? `, and ${won} took ${share} of the top ${TOP}` : ''}.`,
    points: [
      ...(second ? [`${ordinal(second.rank)}: ${second.player} on ${champion(second.legend)}, at ${second.record}.`] : []),
      `Top ${TOP} Legends: ${[...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(', ')}.`,
      'Results from zero.gg.',
    ],
  };
}

const saved = existsSync(SAVED) ? JSON.parse(readFileSync(SAVED, 'utf8')) : [];
let current = saved;
try {
  const { cards } = JSON.parse(readFileSync(CARDS, 'utf8'));
  const { events } = JSON.parse(readFileSync(resolve(here, 'report.json'), 'utf8'));
  const legends = legendsIn(cards);
  const tiles = events.filter((e) => e.top?.length).map((e) => tileOf(e, legends));
  const made = new Set(tiles.map((t) => t.slug));
  current = [...tiles, ...saved.filter((t) => !made.has(t.slug))];
  writeFileSync(SAVED, `${JSON.stringify(current)}\n`);
  console.log(`Tournament news: ${current.length} tiles.`);
} catch (e) {
  // The last good tiles stay up.
  console.error(e.message);
  process.exitCode = 1;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(current));
