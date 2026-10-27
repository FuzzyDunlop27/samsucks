// Plex Media Server access for the channel server: finding the server's token,
// searching the library for the admin page, and turning a channel's sources
// (collections, playlists, shows...) into a flat list of playable items.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const HEADERS = {
  Accept: 'application/json',
  'X-Plex-Product': 'Plecks Channels',
  'X-Plex-Client-Identifier': 'samsucks-channels',
};

// Read the server's own sign-in token when we run on the same machine as Plex,
// so there's nothing to copy and paste. PLEX_TOKEN overrides it.
export function detectToken() {
  if (process.env.PLEX_TOKEN) return process.env.PLEX_TOKEN;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Plex, Inc.\\Plex Media Server', '/v', 'PlexOnlineToken'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/PlexOnlineToken\s+REG_SZ\s+(\S+)/);
      if (m) return m[1];
    } else {
      const paths = [
        '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml',
        '/config/Library/Application Support/Plex Media Server/Preferences.xml', // common Docker mount
        homedir() + '/Library/Application Support/Plex Media Server/Preferences.xml',
      ];
      for (const p of paths) {
        try {
          const m = readFileSync(p, 'utf8').match(/PlexOnlineToken="([^"]+)"/);
          if (m) return m[1];
        } catch (e) { /* not this one */ }
      }
    }
  } catch (e) { /* no local Plex install */ }
  return '';
}

// Only the fields the guide and scheduler use.
function slim(m) {
  const ep = m.type === 'episode';
  return {
    key: String(m.ratingKey),
    type: m.type,
    title: m.title,
    show: ep ? m.grandparentTitle : undefined,
    season: ep ? m.parentIndex : undefined,
    episode: ep ? m.index : undefined,
    year: m.year,
    aired: m.originallyAvailableAt,
    rating: m.contentRating,
    duration: m.duration,
    thumb: ep ? (m.grandparentThumb || m.thumb) : m.thumb,
    art: ep ? (m.grandparentArt || m.art) : m.art,
    summary: m.summary ? m.summary.slice(0, 400) : undefined,
  };
}

const PICKABLE = { movie: 1, show: 1, season: 1, episode: 1, collection: 1, playlist: 1 };
const KIDS_RATINGS = new Set(['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G']);
const KIDS_LIBRARY = /kid|family|child|cartoon/i;

function sortTitle(t) {
  return String(t || '').replace(/^(the|a|an)\s+/i, '');
}

function describe(m) {
  let subtitle = '';
  if (m.type === 'episode') subtitle = m.grandparentTitle + ' · S' + m.parentIndex + 'E' + m.index;
  else if (m.type === 'season') subtitle = m.parentTitle;
  else if (m.type === 'collection') subtitle = (m.childCount || 0) + ' items' + (m.librarySectionTitle ? ' · ' + m.librarySectionTitle : '');
  else if (m.type === 'playlist') subtitle = (m.leafCount || 0) + ' items';
  else if (m.year) subtitle = String(m.year);
  return { type: m.type, key: String(m.ratingKey), title: m.title, subtitle, thumb: m.thumb || m.composite || m.grandparentThumb };
}

export class Plex {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  async get(path, params, token = this.token) {
    const q = new URLSearchParams(params || {});
    const res = await fetch(this.url + path + (q.toString() ? '?' + q : ''), {
      headers: Object.assign({}, HEADERS, token ? { 'X-Plex-Token': token } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const err = new Error('Plex ' + res.status + ' for ' + path);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    return json.MediaContainer || json;
  }

  async identity() {
    const mc = await this.get('/');
    return { name: mc.friendlyName, version: mc.version, id: mc.machineIdentifier };
  }

  // Can this token use the server? Used to let TVs outside the LAN in.
  async accepts(token) {
    try {
      await this.get('/library/sections', null, token || '');
      return true;
    } catch (e) {
      return false;
    }
  }

  // The video libraries (movie and show sections), for the admin filters.
  async libraries() {
    return ((await this.get('/library/sections')).Directory || [])
      .filter(d => d.type === 'movie' || d.type === 'show')
      .map(d => ({ key: String(d.key), title: d.title, type: d.type }));
  }

  // Plex ignores sectionId on /hubs/search, so a library filter is applied
  // here, with a bigger limit so the one library still gets a full list.
  async search(query, section) {
    const mc = await this.get('/hubs/search', { query, limit: section ? 40 : 12, includeCollections: 1, includeExternalMedia: 0 });
    const out = [];
    for (const hub of mc.Hub || []) {
      for (const m of hub.Metadata || []) {
        if (!PICKABLE[m.type] || (section && String(m.librarySectionID) !== section)) continue;
        out.push(describe(m));
      }
    }
    return out;
  }

  // Every collection and video playlist: the usual way to build a channel.
  async browse() {
    const sections = ((await this.get('/library/sections')).Directory || [])
      .filter(d => d.type === 'movie' || d.type === 'show');
    const lists = await Promise.all(sections.map(s =>
      this.get('/library/sections/' + s.key + '/collections').then(mc => (mc.Metadata || []).map(m => {
        m.librarySectionTitle = s.title;
        return describe(m);
      })).catch(() => [])));
    const playlists = ((await this.get('/playlists', { playlistType: 'video' })).Metadata || []).map(describe);
    return lists.flat().concat(playlists);
  }

  // Every movie and show in every video library, A to Z, for browsing when
  // you don't know what to search for. `kids` marks family-rated titles and
  // anything in a library named like "Kids" or "Family".
  async all() {
    const sections = ((await this.get('/library/sections')).Directory || [])
      .filter(d => d.type === 'movie' || d.type === 'show');
    const lists = await Promise.all(sections.map(s =>
      this.get('/library/sections/' + s.key + '/all').then(mc => (mc.Metadata || []).map(m => {
        const d = describe(m);
        d.library = s.title;
        d.section = String(s.key);
        d.rating = m.contentRating || '';
        d.kids = KIDS_RATINGS.has(d.rating) || KIDS_LIBRARY.test(s.title);
        const seasons = m.type === 'show' && m.childCount ? m.childCount + (m.childCount === 1 ? ' season' : ' seasons') : '';
        d.subtitle = [m.year, seasons, d.rating, s.title].filter(Boolean).join(' · ');
        return d;
      })).catch(() => [])));
    return lists.flat().sort((a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)));
  }

  async expand(m) {
    if (m.type === 'movie' || m.type === 'episode') return m.duration ? [slim(m)] : [];
    if (m.type === 'show') return this.list('/library/metadata/' + m.ratingKey + '/allLeaves');
    if (m.type === 'season') return this.list('/library/metadata/' + m.ratingKey + '/children');
    if (m.type === 'collection') return this.list('/library/collections/' + m.ratingKey + '/children');
    return [];
  }

  async list(path) {
    const mc = await this.get(path);
    const parts = [];
    for (const m of mc.Metadata || []) parts.push(await this.expand(m));
    return parts.flat();
  }

  // One source → playable items, in the source's own order.
  async resolve(src) {
    if (src.type === 'playlist') return this.list('/playlists/' + src.key + '/items');
    if (src.type === 'collection') return this.list('/library/collections/' + src.key + '/children');
    const mc = await this.get('/library/metadata/' + src.key);
    const m = (mc.Metadata || [])[0];
    return m ? this.expand(m) : [];
  }

  async resolveAll(sources) {
    const seen = new Set();
    const out = [];
    for (const src of sources || []) {
      let items = [];
      try { items = await this.resolve(src); } catch (e) { console.warn('source failed', src.title || src.key, e.message); }
      for (const it of items) {
        // Skip duplicates and anything too short to schedule (trailers, stubs).
        if (seen.has(it.key) || !(it.duration > 30000)) continue;
        seen.add(it.key);
        out.push(it);
      }
    }
    return out;
  }

  // Small poster for the admin page, resized by Plex.
  async image(path, size) {
    const q = new URLSearchParams({ width: size, height: size, minSize: 1, upscale: 1, url: path });
    const res = await fetch(this.url + '/photo/:/transcode?' + q, {
      headers: Object.assign({}, HEADERS, { 'X-Plex-Token': this.token }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('image ' + res.status);
    return { type: res.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
  }
}
