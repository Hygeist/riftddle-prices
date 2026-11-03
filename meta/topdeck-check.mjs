// One read-only question for TopDeck.gg: which Riftbound Constructed events of 250+ players does it hold, and do they carry deck lists?
// Run by .github/workflows/topdeck-check.yml. Prints event names and counts, never the key. Writes nothing to the site.

import { appendFileSync } from 'node:fs';

const KEY = process.env.TOPDECK_API_KEY;
if (!KEY) throw new Error('TOPDECK_API_KEY is not set');

const res = await fetch('https://topdeck.gg/api/v2/tournaments', {
  method: 'POST',
  headers: { Authorization: KEY, 'Content-Type': 'application/json', 'User-Agent': 'RiftRiddleMeta/1.0 (+https://riftddle.com)' },
  body: JSON.stringify({ game: 'Riftbound', format: 'Constructed', participantMin: 250, last: 200, columns: ['name', 'decklist', 'wins', 'draws', 'losses'] }),
});
if (!res.ok) throw new Error(`TopDeck: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
const events = await res.json();

const deckOf = (p) => p.deckObj ?? p.decklist;
const lines = [`Events of 250+ players in the last 200 days: ${events.length}`, ''];
for (const e of [...events].sort((a, b) => (b.startDate ?? 0) - (a.startDate ?? 0))) {
  const top = (e.standings ?? []).slice(0, 10);
  const date = e.startDate ? new Date(e.startDate * 1000).toISOString().slice(0, 10) : '?';
  lines.push(`${date} | ${e.tournamentName ?? e.name ?? e.TID} | ${e.topCut ?? '-'} cut | ${e.registeredCount ?? e.standings?.length ?? '?'} players | ${top.filter(deckOf).length} of ${top.length} top decks | ${e.TID}`);
}
const sample = events.flatMap((e) => e.standings ?? []).find(deckOf);
lines.push('', `Event fields: ${Object.keys(events[0] ?? {}).join(', ')}`, `Standing fields: ${Object.keys(events[0]?.standings?.[0] ?? {}).join(', ')}`);
if (sample) lines.push('', 'Sample deck list:', JSON.stringify(deckOf(sample)).slice(0, 1500));

const text = lines.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);
