// Screensaver: after a while with no remote input, cross-fade through random
// backdrops from the server's libraries (filtered for the kids profile). Any
// key wakes it, and that key does nothing else. Runs over a paused video, but
// never while one is playing.
//
// While ours is enabled the TV's own screen saver is switched off, otherwise
// the system one would kick in first.
import { h, setText } from '../util/dom.js';
import { session } from '../session.js';
import { setScreenSaver } from '../platform/tizen.js';
import * as profile from '../profile.js';
import * as store from '../util/store.js';
import { warn } from '../util/log.js';

export const DELAYS = [5, 15, 0]; // minutes; 0 = off
const SLIDE_MS = 12000;
const POOL_MAX = 120;

let el = null;
let imgs = null;
let caption = null;
let clock = null;
let front = 0;
let idleTimer = 0;
let slideTimer = 0;
let clockTimer = 0;
let pool = [];
let next = 0;
let active = false;
let token = 0;

export function delay() {
  const d = store.get('screensaver', DELAYS[0]);
  return DELAYS.indexOf(d) >= 0 ? d : DELAYS[0];
}

export function setDelay(minutes) {
  store.set('screensaver', minutes);
  syncSystemSaver();
  arm();
}

// The TV's screen saver is on only when ours is off (playback turns it off too).
export function syncSystemSaver() {
  setScreenSaver(!delay());
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

async function loadPool() {
  const server = session.server;
  const sections = profile.visibleSections(await server.sections());
  const lists = await Promise.all(sections.map(s => {
    // Family stand-ins (kids profile) have to be filtered here; Plex can't.
    if (s.family) return profile.familyItems(server, s).then(items => shuffle(items).slice(0, 30)).catch(() => []);
    return server.get('/library/sections/' + s.key + '/all', {
      sort: 'random', 'X-Plex-Container-Size': 30, excludeFields: 'summary,tagline',
    }).then(mc => mc.Metadata || []).catch(() => []);
  }));
  const seen = {};
  const out = [];
  [].concat(...lists).forEach(it => {
    if (!it.art || seen[it.art]) return;
    seen[it.art] = 1;
    out.push({ art: it.art, title: it.title, year: it.year });
  });
  return shuffle(out).slice(0, POOL_MAX);
}

function build() {
  el = h('div', 'saver hidden', document.body);
  imgs = [h('img', 'saver-img', el), h('img', 'saver-img', el)];
  h('div', 'saver-fade', el);
  const corner = h('div', 'saver-corner', el);
  clock = h('div', 'saver-clock', corner);
  caption = h('div', 'saver-title', corner);
}

function tick() {
  const d = new Date();
  const hh = d.getHours() % 12 || 12;
  setText(clock, hh + ':' + String(d.getMinutes()).padStart(2, '0'));
}

function showNext() {
  if (!active || !pool.length) return;
  const item = pool[next++ % pool.length];
  const url = session.server.image(item.art, 1920, 1080, { quality: 80 });
  const t = token;
  const back = imgs[1 - front];
  const loader = new Image();
  loader.src = url;
  const swap = () => {
    if (!active || t !== token) return;
    back.src = url;
    back.classList.add('on');
    imgs[front].classList.remove('on');
    front = 1 - front;
    setText(caption, item.title + (item.year ? '  ·  ' + item.year : ''));
    slideTimer = setTimeout(showNext, SLIDE_MS);
  };
  // A broken image just skips to the next one.
  const skip = () => { if (active && t === token) slideTimer = setTimeout(showNext, 500); };
  if (loader.decode) loader.decode().then(swap, skip);
  else { loader.onload = swap; loader.onerror = skip; }
}

function canRun() {
  const root = document.documentElement.classList;
  return session.server && !document.hidden && (!root.contains('playing') || root.contains('video-paused'));
}

export async function show() {
  if (active || !canRun()) return;
  if (!el) build();
  active = true;
  const t = ++token;
  try {
    if (!pool.length) pool = await loadPool();
  } catch (e) {
    warn('screensaver art failed', e.message);
  }
  if (t !== token || !active) return;
  if (!pool.length) { active = false; return; }
  tick();
  clockTimer = setInterval(tick, 10000);
  el.classList.remove('hidden');
  showNext();
}

export function hide() {
  if (!active) return;
  active = false;
  token++;
  clearTimeout(slideTimer);
  clearInterval(clockTimer);
  el.classList.add('hidden');
  imgs.forEach(i => { i.classList.remove('on'); i.removeAttribute('src'); });
  // Fresh random picks next time.
  pool = [];
}

function arm() {
  clearTimeout(idleTimer);
  const d = delay();
  if (d) idleTimer = setTimeout(show, d * 60e3);
}

export function initScreensaver() {
  // Runs before input.js's capture listener on document, so the waking key
  // can be swallowed.
  window.addEventListener('keydown', e => {
    if (active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hide();
    }
    arm();
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hide(); arm(); });
  syncSystemSaver();
  arm();
}
