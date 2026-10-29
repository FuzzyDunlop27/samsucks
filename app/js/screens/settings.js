// Account, server and diagnostics.
import { DEV, VERSION } from '../config.js';
import { h, toggleClass } from '../util/dom.js';
import { session, signOut, useServer } from '../session.js';
import { getServers, connect } from '../plex/auth.js';
import { setHud, hudEnabled } from '../ui/hud.js';
import * as router from '../router.js';
import { ServerPicker } from './login.js';
import { error } from '../util/log.js';
import { baseUrl as channelServer } from '../channels/client.js';
import { useAmbience, setLegacyGradients, legacyGradients } from '../ui/backdrop.js';
import * as profile from '../profile.js';
import * as store from '../util/store.js';
import * as screensaver from '../ui/screensaver.js';

export function SettingsScreen() {
  const el = h('div', 'screen settings');
  const ambience = useAmbience();
  h('h1', 'settings-title', el).textContent = 'Settings';
  const list = h('div', 'settings-list', el);
  const foot = h('div', 'settings-foot', el);
  foot.textContent = 'Plecks '+ VERSION + (DEV ? ' (dev)' : '') + ' · ' + (session.server ? session.server.uri.replace(/X-Plex-Token=.*/, '') : '');

  let index = 0;
  let items = [];

  function build() {
    list.innerHTML = '';
    const who = profile.PROFILES.find(p => p.id === profile.current());
    items = [
      { label: 'Profile', value: who ? who.label : '—', run: switchProfile, action: 'Switch' },
    ];
    // The kids profile can switch back, but not change anything else.
    if (!profile.isKids()) items = items.concat([
      { label: 'Kids libraries', value: '', run: () => router.push(KidsLibraries()), action: 'Choose' },
      { label: 'Server', value: session.server ? session.server.name : '—', run: switchServer },
      { label: 'Signed in as', value: session.user ? session.user.title : '—', run: doSignOut, action: 'Sign out' },
      // Channels are set up in a browser at this address (channels/server.mjs).
      { label: 'Screensaver', value: screensaver.delay() ? 'After ' + screensaver.delay() + ' min' : 'Off', run: cycleSaver },
      { label: 'Channel server', value: channelServer() || '—', run: () => {} },
      { label: 'Performance overlay', value: hudEnabled() ? 'On' : 'Off', run: () => { setHud(!hudEnabled()); build(); } },
      // For before/after recordings: brings back the full-screen gradients that took ~2s per repaint.
      { label: 'Demo: original slow renderer', value: legacyGradients() ? 'On' : 'Off', run: () => { setLegacyGradients(!legacyGradients()); build(); } },
    ]);
    items.forEach(it => {
      it.el = h('div', 'setting', list);
      h('span', 'setting-label', it.el).textContent = it.label;
      h('span', 'setting-value', it.el).textContent = [it.value, it.action].filter(Boolean).join('  ·  ');
    });
    render();
  }

  function render() {
    items.forEach((it, i) => toggleClass(it.el, 'focus', i === index));
  }

  async function switchServer() {
    try {
      const servers = await getServers(session.token);
      if (servers.length === 1) {
        const uri = await connect(servers[0]);
        useServer(servers[0], uri);
        restart();
        return;
      }
      router.push(ServerPicker({ servers, onDone: restart }));
    } catch (e) {
      error('server list failed', e);
    }
  }

  function cycleSaver() {
    const d = screensaver.DELAYS;
    screensaver.setDelay(d[(d.indexOf(screensaver.delay()) + 1) % d.length]);
    build();
  }

  function switchProfile() {
    profile.forget();
    restart();
  }

  function doSignOut() {
    signOut();
    restart();
  }

  function restart() {
    // Rebuild from scratch: app.js decides between login and home.
    window.dispatchEvent(new Event('samsucks:restart'));
  }

  build();

  return {
    el,
    name: 'settings',
    onShow() { ambience.restore(); },
    onKey(action) {
      if (action === 'up') { index = Math.max(0, index - 1); render(); return true; }
      if (action === 'down') { index = Math.min(items.length - 1, index + 1); render(); return true; }
      if (action === 'enter') { items[index].run(); return true; }
      return false;
    },
  };
}

// Which libraries the kids profile shows as-is. Everything else it sees only
// as a "Family …" version holding kid/family titles.
function KidsLibraries() {
  const el = h('div', 'screen settings');
  const ambience = useAmbience();
  h('h1', 'settings-title', el).textContent = 'Kids libraries';
  const list = h('div', 'settings-list', el);
  h('div', 'settings-foot', el).textContent = 'OK turns a library on or off for the Kids profile.';

  let index = 0;
  let rows = [];

  function build(sections) {
    const keys = profile.kidsKeys(sections);
    list.innerHTML = '';
    rows = sections.map(s => {
      const on = keys.indexOf(String(s.key)) >= 0;
      const row = { key: String(s.key), on, el: h('div', 'setting', list) };
      h('span', 'setting-label', row.el).textContent = s.title;
      h('span', 'setting-value', row.el).textContent = on ? 'Kids library' : 'Family titles only';
      return row;
    });
    render();
  }

  function render() {
    rows.forEach((r, i) => toggleClass(r.el, 'focus', i === index));
  }

  let sections = [];
  session.server.sections().then(secs => { sections = secs; build(secs); }).catch(e => error('sections failed', e));

  return {
    el,
    name: 'kids-libraries',
    onShow() { ambience.restore(); },
    onKey(action) {
      if (action === 'up') { index = Math.max(0, index - 1); render(); return true; }
      if (action === 'down') { index = Math.min(rows.length - 1, index + 1); render(); return true; }
      if (action === 'enter' && rows[index]) {
        rows[index].on = !rows[index].on;
        profile.setKidsKeys(rows.filter(r => r.on).map(r => r.key));
        store.set('homeCache', undefined);
        build(sections);
        return true;
      }
      return false;
    },
  };
}
