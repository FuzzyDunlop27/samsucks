// Channel timelines. Each channel keeps a saved list of what airs when,
// generated a few days ahead. Editing a channel only rewrites what hasn't
// started yet, so whatever is on now keeps playing on every TV.
//
// A timeline entry is { k: ratingKey, s: start ms, d: duration ms, m: metadata }.
import { createHash } from 'node:crypto';

export const HORIZON_MS = 3 * 24 * 3600e3;   // how far ahead we plan
const REFILL_MS = 2 * 24 * 3600e3;           // top up once less than this is left
const KEEP_PAST_MS = 6 * 3600e3;             // guide can look back this far
const SLOT_MS = 30 * 60e3;                   // fresh channels start on a half hour

export const ORDERS = ['shuffle', 'episode', 'release', 'custom'];

export function configHash(ch) {
  return createHash('sha1').update(JSON.stringify([ch.sources, ch.order, ch.seed])).digest('hex').slice(0, 12);
}

// mulberry32: tiny seeded PRNG so a channel's shuffle is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, seed) {
  const out = list.slice();
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function byText(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

// 'custom' and 'shuffle' keep source order; shuffle is applied per cycle in pick().
export function ordered(items, order) {
  const list = items.slice();
  if (order === 'release') {
    list.sort((a, b) => byText(a.aired || a.year, b.aired || b.year) || byText(a.title, b.title));
  } else if (order === 'episode') {
    list.sort((a, b) => byText(a.show || a.title, b.show || b.title) ||
      (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
  }
  return list;
}

function pick(state, ch, list, byKey) {
  let m;
  if (ch.order === 'shuffle') {
    state.bag = (state.bag || []).filter(k => byKey.has(k));
    if (!state.bag.length) {
      state.cycle = (state.cycle || 0) + 1;
      state.bag = shuffled(list.map(x => x.key), (ch.seed || 1) * 1000003 + state.cycle);
      // Never air the same thing twice in a row across a cycle boundary.
      if (state.bag.length > 1 && state.bag[0] === state.lastKey) state.bag.push(state.bag.shift());
    }
    m = list[byKey.get(state.bag.shift())];
  } else {
    // Continue after whatever aired last, even if the list was edited since.
    const next = byKey.has(state.lastKey) ? byKey.get(state.lastKey) + 1 : (state.cursor || 0);
    const i = next % list.length;
    m = list[i];
    state.cursor = i + 1;
  }
  state.lastKey = m.key;
  return m;
}

export function needsRefill(state, now) {
  const last = state.items[state.items.length - 1];
  return !last || last.s + last.d < now + REFILL_MS;
}

// Append entries until the timeline reaches now + HORIZON_MS.
export function extend(state, ch, items, now) {
  if (!items.length) return;
  const list = ordered(items, ch.order);
  const byKey = new Map(list.map((m, i) => [m.key, i]));
  const last = state.items[state.items.length - 1];
  let t;
  if (last && last.s + last.d >= now) {
    t = last.s + last.d;
  } else {
    // Empty, or the server was off long enough for the timeline to run out.
    state.items = [];
    t = Math.floor(now / SLOT_MS) * SLOT_MS;
  }
  const until = now + HORIZON_MS;
  while (t < until) {
    const m = pick(state, ch, list, byKey);
    state.items.push({ k: m.key, s: t, d: m.duration, m });
    t += m.duration;
  }
}

// The channel changed: keep the past and what's airing, regenerate the rest.
export function rewriteFuture(state, now) {
  state.items = state.items.filter(e => e.s <= now);
  const last = state.items[state.items.length - 1];
  state.lastKey = last ? last.k : null;
  state.bag = [];
}

export function prune(state, now) {
  const cutoff = now - KEEP_PAST_MS;
  let i = 0;
  while (i < state.items.length && state.items[i].s + state.items[i].d < cutoff) i++;
  if (i) state.items.splice(0, i);
}

export function airing(state, at) {
  // Timelines are a few hundred entries; a linear scan is plenty.
  for (let i = 0; i < state.items.length; i++) {
    const e = state.items[i];
    if (e.s <= at && at < e.s + e.d) return i;
  }
  return -1;
}

export function between(state, from, to) {
  return state.items.filter(e => e.s < to && e.s + e.d > from);
}
