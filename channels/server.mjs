// Plecks channel server: virtual channels built from your Plex library.
// Runs next to Plex, stores channel setup and schedules as JSON, and answers
// two questions for the TV app: "what's the guide?" and "what's on channel N
// right now, and how far in?". Video never passes through here; the TV plays
// the file straight from Plex.
//
//   node channels/server.mjs        (PORT, PLEX_URL, PLEX_TOKEN, DATA_DIR optional)
//   admin page: http://<this machine>:32500/
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Plex, detectToken } from './plex.mjs';
import * as sched from './schedule.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 32500);
const DATA = process.env.DATA_DIR || join(HERE, 'data');
const CONTENT_TTL = 10 * 60e3;
const GUIDE_MAX_MS = 24 * 3600e3;

mkdirSync(DATA, { recursive: true });

// --- storage ------------------------------------------------------------

function load(name, fallback) {
  try { return JSON.parse(readFileSync(join(DATA, name), 'utf8')); } catch (e) { return fallback; }
}

const timers = {};
function save(name, value) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    const file = join(DATA, name);
    writeFileSync(file + '.tmp', JSON.stringify(value));
    renameSync(file + '.tmp', file);
  }, 200);
}

const settings = Object.assign({ plexUrl: process.env.PLEX_URL || 'http://127.0.0.1:32400' }, load('settings.json', {}));
const db = load('channels.json', { channels: [] });
const schedules = load('schedules.json', {});

const plex = new Plex(settings.plexUrl, detectToken());
if (!plex.token) console.warn('No Plex token found. Set PLEX_TOKEN, or run this on the Plex server machine.');

// --- channels -------------------------------------------------------------

function sortedChannels() {
  return db.channels.slice().sort((a, b) => a.number - b.number);
}

function publicChannel(ch) {
  return { id: ch.id, number: ch.number, name: ch.name, logo: ch.logo || '' };
}

function cleanChannel(input, existing) {
  const ch = Object.assign({}, existing || {});
  if (input.name != null) ch.name = String(input.name).trim().slice(0, 60) || 'Channel';
  if (input.number != null) ch.number = Math.max(1, Math.min(9999, Math.round(Number(input.number)) || 1));
  if (input.logo != null) ch.logo = String(input.logo).trim();
  if (input.order != null) ch.order = sched.ORDERS.includes(input.order) ? input.order : 'shuffle';
  if (Array.isArray(input.sources)) {
    ch.sources = input.sources.filter(s => s && s.type && s.key).map(s => ({
      type: String(s.type), key: String(s.key), title: String(s.title || ''), subtitle: String(s.subtitle || ''),
    }));
  }
  if (input.reshuffle) ch.seed = randomBytes(4).readUInt32LE() || 1;
  return ch;
}

const contentCache = new Map(); // channel id -> { hash, at, items }

async function content(ch) {
  const hash = sched.configHash(ch);
  const hit = contentCache.get(ch.id);
  if (hit && hit.hash === hash && Date.now() - hit.at < CONTENT_TTL) return hit.items;
  const items = await plex.resolveAll(ch.sources);
  contentCache.set(ch.id, { hash, at: Date.now(), items });
  return items;
}

// One timeline update per channel at a time; concurrent guide requests share it.
const pending = new Map();

function timeline(ch) {
  if (pending.has(ch.id)) return pending.get(ch.id);
  const p = (async () => {
    const now = Date.now();
    const st = schedules[ch.id] || (schedules[ch.id] = { items: [] });
    const hash = sched.configHash(ch);
    if (st.hash !== hash) {
      if (st.hash) sched.rewriteFuture(st, now);
      st.hash = hash;
    }
    sched.prune(st, now);
    if (sched.needsRefill(st, now) && (ch.sources || []).length) {
      sched.extend(st, ch, await content(ch), now);
      save('schedules.json', schedules);
    }
    return st;
  })().finally(() => pending.delete(ch.id));
  pending.set(ch.id, p);
  return p;
}

function program(e) {
  return Object.assign({ start: e.s, end: e.s + e.d }, e.m);
}

async function guide(from, to) {
  const chans = sortedChannels();
  const lines = await Promise.all(chans.map(async ch => {
    let programs = [];
    try { programs = sched.between(await timeline(ch), from, to).map(program); } catch (e) { console.warn('guide failed for', ch.name, e.message); }
    return Object.assign(publicChannel(ch), { programs });
  }));
  return { now: Date.now(), from, to, channels: lines };
}

async function nowOn(ch) {
  const st = await timeline(ch);
  const now = Date.now();
  let i = sched.airing(st, now);
  if (i < 0) return null;
  // A few seconds left: start the next item instead of a blink of the old one.
  if (st.items[i].s + st.items[i].d - now < 4000 && st.items[i + 1]) i++;
  const e = st.items[i];
  return {
    now,
    channel: publicChannel(ch),
    program: program(e),
    offset: Math.max(0, now - e.s),
    next: st.items.slice(i + 1, i + 3).map(program),
  };
}

// --- http -----------------------------------------------------------------

function isLan(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd]/i.test(ip);
}

const okTokens = new Map(); // token -> expiry

async function allowed(req, url) {
  if (isLan(req)) return true;
  const token = req.headers['x-plex-token'] || url.searchParams.get('X-Plex-Token') || '';
  if (!token) return false;
  if (okTokens.get(token) > Date.now()) return true;
  if (!(await plex.accepts(token))) return false;
  okTokens.set(token, Date.now() + 3600e3);
  return true;
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveAdmin(res, path) {
  const file = join(HERE, 'admin', path === '/' ? 'index.html' : path.replace(/\.\./g, ''));
  if (!existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

function findChannel(id) {
  return db.channels.find(c => c.id === id);
}

async function route(req, res, url) {
  const path = url.pathname;
  const m = path.match(/^\/api\/(?:admin\/)?channels\/([^/]+)(\/now|\/preview)?$/);

  // TV app endpoints: LAN, or a token that this Plex server accepts.
  if (path === '/api/channels' || path === '/api/guide' || (m && m[2] === '/now')) {
    if (!(await allowed(req, url))) return send(res, 401, { error: 'unauthorized' });
    if (path === '/api/channels') return send(res, 200, { channels: sortedChannels().map(publicChannel) });
    if (path === '/api/guide') {
      const now = Date.now();
      const from = Number(url.searchParams.get('from')) || now - 30 * 60e3;
      const to = Math.min(Number(url.searchParams.get('to')) || now + 4 * 3600e3, from + GUIDE_MAX_MS);
      return send(res, 200, await guide(from, to));
    }
    const ch = findChannel(m[1]);
    if (!ch) return send(res, 404, { error: 'no such channel' });
    const on = await nowOn(ch);
    return on ? send(res, 200, on) : send(res, 404, { error: 'nothing scheduled' });
  }

  // Admin page and its API: home network only.
  if (!isLan(req)) return send(res, 403, { error: 'admin is only available on your home network' });

  if (path === '/api/admin/status') {
    let server = null;
    try { server = await plex.identity(); } catch (e) { /* offline */ }
    const signedIn = !!plex.token && await plex.accepts(plex.token);
    return send(res, 200, { plexUrl: plex.url, server, signedIn, channels: db.channels.length });
  }
  if (path === '/api/admin/channels' && req.method === 'GET') return send(res, 200, { channels: sortedChannels() });
  if (path === '/api/admin/channels' && req.method === 'POST') {
    const body = await readBody(req);
    const number = body.number || (db.channels.reduce((n, c) => Math.max(n, c.number), 0) + 1);
    const ch = cleanChannel(Object.assign({ name: 'New channel', order: 'shuffle', sources: [] }, body, { number }));
    ch.id = randomBytes(5).toString('hex');
    ch.seed = randomBytes(4).readUInt32LE() || 1;
    db.channels.push(ch);
    save('channels.json', db);
    return send(res, 201, ch);
  }
  if (m && !m[2] && path.startsWith('/api/admin/')) {
    const ch = findChannel(m[1]);
    if (!ch) return send(res, 404, { error: 'no such channel' });
    if (req.method === 'PUT') {
      Object.assign(ch, cleanChannel(await readBody(req), ch));
      save('channels.json', db);
      return send(res, 200, ch);
    }
    if (req.method === 'DELETE') {
      db.channels = db.channels.filter(c => c !== ch);
      delete schedules[ch.id];
      contentCache.delete(ch.id);
      save('channels.json', db);
      save('schedules.json', schedules);
      return send(res, 200, { ok: true });
    }
  }
  if (m && m[2] === '/preview') {
    const ch = findChannel(m[1]);
    if (!ch) return send(res, 404, { error: 'no such channel' });
    const st = await timeline(ch);
    const now = Date.now();
    const i = Math.max(0, sched.airing(st, now));
    return send(res, 200, { now, total: (await content(ch)).length, programs: st.items.slice(i, i + 12).map(program) });
  }
  if (path === '/api/admin/plex/search') return send(res, 200, { results: await plex.search(url.searchParams.get('q') || '', url.searchParams.get('section') || '') });
  if (path === '/api/admin/plex/libraries') return send(res, 200, { results: await plex.libraries() });
  if (path === '/api/admin/plex/browse') return send(res, 200, { results: await plex.browse() });
  if (path === '/api/admin/plex/all') return send(res, 200, { results: await plex.all() });
  if (path === '/api/admin/plex/image') {
    const img = await plex.image(url.searchParams.get('path'), Number(url.searchParams.get('size')) || 96);
    res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'max-age=86400' });
    return res.end(img.body);
  }
  if (req.method === 'GET' && !path.startsWith('/api/')) return serveAdmin(res, path);
  return send(res, 404, { error: 'not found' });
}

createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  try {
    await route(req, res, url);
  } catch (e) {
    console.error(req.method, url.pathname, e.message);
    if (!res.headersSent) send(res, e.status === 401 ? 502 : 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log('Plecks channels on http://localhost:' + PORT + '  (Plex: ' + plex.url + ', token ' + (plex.token ? 'found' : 'missing') + ')');
});
