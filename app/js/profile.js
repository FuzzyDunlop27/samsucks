// Who's watching. The normal profile sees everything. The kids profile sees the
// kids libraries, plus "Family" versions of the other libraries that only hold
// kid/family titles, and nothing else (home rows and search are filtered too).
import * as store from './util/store.js';

export const PROFILES = [
  { id: 'normal', label: 'Everyone' },
  { id: 'kids', label: 'Kids' },
];

// A title is kid/family when it has one of these genres or ratings...
const KID_GENRES = /^(family|kids|children|animation)$/i;
const KID_RATINGS = ['G', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G'];
// ...and never when it's rated for grown-ups (Animation also covers South Park).
const ADULT_RATINGS = { R: 1, 'NC-17': 1, X: 1, 'TV-MA': 1, 'TV-14': 1 };

let active = null;

export function current() {
  return active || store.get('profile') || 'normal';
}

export function isKids() {
  return current() === 'kids';
}

export function choose(id) {
  active = id;
  store.set('profile', id); // the picker starts on the last one used
}

export function forget() {
  active = null;
}

export function chosen() {
  return active != null;
}

// Kids libraries: picked in Settings, or guessed from the library names.
export function kidsKeys(sections) {
  const saved = store.get('kidsSections');
  if (saved) return saved;
  return sections.filter(s => /\bkid|child/i.test(s.title)).map(s => String(s.key));
}

export function setKidsKeys(keys) {
  store.set('kidsSections', keys);
}

function bareRating(r) {
  return String(r || '').replace(/^[a-z]{2}\//, ''); // "us/TV-Y" -> "TV-Y"
}

function adult(item) {
  return !!ADULT_RATINGS[bareRating(item.contentRating)];
}

// For lists we can't ask Plex to filter (home hubs, search): kids libraries,
// or a kid rating anywhere else.
export function kidSafe(item, keys) {
  if (keys.indexOf(String(item.librarySectionID)) >= 0) return true;
  return KID_RATINGS.indexOf(bareRating(item.contentRating)) >= 0;
}

// Library sections as this profile sees them. Kids get their own libraries
// plus a filtered "Family …" stand-in for each of the others.
export function visibleSections(sections) {
  if (!isKids()) return sections;
  const keys = kidsKeys(sections);
  const own = sections.filter(s => keys.indexOf(String(s.key)) >= 0);
  const family = sections.filter(s => keys.indexOf(String(s.key)) < 0).map(s => ({
    key: s.key, type: s.type, title: 'Family ' + s.title, family: true,
  }));
  return own.concat(family);
}

// Every kid/family title in a (non-kids) library: one query by genre, one by
// rating, merged. These subsets are small enough to load whole.
export async function familyItems(server, section) {
  const type = section.type === 'show' ? 2 : 1;
  const path = '/library/sections/' + section.key + '/all';
  const common = { type, excludeFields: 'summary,tagline' };
  const genres = await server.get('/library/sections/' + section.key + '/genre', { type }, { maxAge: 300000 });
  const ids = (genres.Directory || []).filter(g => KID_GENRES.test(g.title)).map(g => g.key);
  const [byGenre, byRating] = await Promise.all([
    ids.length ? server.get(path, Object.assign({ genre: ids.join(',') }, common), { maxAge: 300000 }) : {},
    server.get(path, Object.assign({ contentRating: KID_RATINGS.join(',') }, common), { maxAge: 300000 }),
  ]);
  const seen = {};
  return (byGenre.Metadata || []).concat(byRating.Metadata || []).filter(it => {
    if (seen[it.ratingKey] || adult(it)) return false;
    seen[it.ratingKey] = true;
    return true;
  });
}
