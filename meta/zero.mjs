// Reading zero.gg's public pages, shared by the Meta report (report.mjs) and the player history (players.mjs).
// zero.gg sends its data inside the page as JavaScript objects, so this looks for the flat records by their fields.

export const SITE = 'https://www.zero.gg/riftbound';
export const AGENT = 'RiftRiddleMeta/1.0 (+https://riftddle.com)';
export const MIN_PLAYERS = 250;
/** Limited and team events, and the side events at a Regional Qualifier ("Regional Rebound - RQ Hartford"). */
export const SIDE_EVENT = /sealed|draft|2v2|\bRQ\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pause = () => sleep(3000 + Math.random() * 3000);

export async function page(path) {
  const res = await fetch(`${SITE}${path}`, { headers: { 'User-Agent': AGENT } });
  if (!res.ok) throw new Error(`zero.gg ${path}: HTTP ${res.status}`);
  return res.text();
}

const field = (record, name) => new RegExp(`[{,]${name}:("(?:[^"\\\\]|\\\\.)*"|-?[\\d.]+)`).exec(record)?.[1];
export const count = (record, name) => Number(field(record, name) ?? 0);
export function text(record, name) {
  const raw = field(record, name);
  if (!raw) return '';
  try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
}
export const bare = (legend) => legend.replace(/ - Starter$/, '');

/** Finished main events of 250+ players on zero.gg's event list, from a date on. `overrides` is a page carrying zero.gg's own side-event marks. */
export function eventsIn(list, overrides, from) {
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

/** An event's final top ranks, with zero.gg's player id so a player is the same person across events whatever name they use. */
export async function standings(id, upTo = 10) {
  const html = await page(`/events/${id}/standings`);
  const rows = new Map();
  for (const r of html.match(/\{[^{}]*playerName:[^{}]*\}/g) ?? []) {
    const rank = count(r, 'rank');
    if (rank >= 1 && rank <= upTo && !rows.has(rank)) rows.set(rank, { rank, player: text(r, 'playerName'), playerId: count(r, 'playerId') || undefined, legend: bare(text(r, 'leader')), record: text(r, 'record') });
  }
  return [...rows.values()].sort((a, b) => a.rank - b.rank);
}
