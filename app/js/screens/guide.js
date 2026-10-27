// Guide: a TV-style grid of virtual channels and what's on. OK tunes in, and
// playback starts where the channel is "at", straight from the file on Plex.
// Schedules come from the channel server (channels/server.mjs).
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { useAmbience, HeroArt } from '../ui/backdrop.js';
import { session } from '../session.js';
import { episodeLabel } from '../util/format.js';
import * as chans from '../channels/client.js';
import { tune } from '../nav.js';
import { error } from '../util/log.js';

const SLOT = 30 * 60e3;
const SPAN = 2 * 3600e3;          // time visible across the grid
const FETCH_AHEAD = 6 * 3600e3;   // fetch this much past the visible window
const REFRESH_MS = 10 * 60e3;     // pick up channel edits
const GRID_X = 400;               // programs start here
const GRID_W = 1424;
const PX = GRID_W / SPAN;
const ROW_H = 104;
const ROW_STEP = ROW_H + 10;
const VISIBLE = 5;

function slotOf(ms) {
  return Math.floor(ms / SLOT) * SLOT;
}

function clockTime(ms) {
  const d = new Date(ms);
  let hh = d.getHours();
  const mm = d.getMinutes();
  hh = hh % 12 || 12;
  return hh + ':' + (mm < 10 ? '0' : '') + mm;
}

function ampm(ms) {
  return new Date(ms).getHours() >= 12 ? 'PM' : 'AM';
}

function titleOf(p) {
  return p.type === 'episode' ? p.show : p.title;
}

function subOf(p) {
  if (p.type === 'episode') return 'S' + (p.season || 0) + ' E' + (p.episode || 0) + '  ' + p.title;
  return p.year ? String(p.year) : '';
}

export function GuideScreen() {
  const el = h('div', 'screen guide');
  const ambience = useAmbience();
  const hero = new HeroArt(el, 'hero-art guide-art');

  const head = h('div', 'guide-head', el);
  h('div', 'guide-title', head).textContent = 'Guide';
  const clockEl = h('div', 'guide-clock', head);

  const info = h('div', 'guide-info', el);
  const infoTitle = h('h1', 'guide-info-title', info);
  const infoMeta = h('div', 'guide-info-meta', info);
  const infoSummary = h('p', 'guide-info-summary', info);

  const times = h('div', 'guide-times', el);
  const clip = h('div', 'guide-rows', el);
  const track = h('div', 'guide-track', clip);
  const nowLine = h('div', 'guide-now', el);
  const message = h('div', 'guide-message hidden', el);

  let data = null;        // last /api/guide response
  let loadedTo = 0;
  let rows = [];          // { ch, el, progEl, blocks: Map(program -> el) }
  let rowIndex = 0;
  let firstRow = 0;
  let ws = slotOf(Date.now());   // window start
  let focus = null;              // focused program object
  let focusTime = Date.now();
  let tickTimer = 0;
  let refreshTimer = 0;
  let loading = false;
  let tuning = false;

  function showMessage(text) {
    setText(message, text);
    toggleClass(message, 'hidden', !text);
  }

  // --- data ---------------------------------------------------------------

  async function load(keepFocus) {
    if (loading) return;
    loading = true;
    const from = slotOf(Date.now());
    const to = Math.max(ws + SPAN, from + SPAN) + FETCH_AHEAD;
    try {
      const res = await chans.guide(from, to);
      data = res;
      loadedTo = to;
      if (!res.channels.length) {
        showMessage('No channels yet. Open ' + chans.baseUrl() + ' in a browser on your network to create one.');
      } else {
        showMessage('');
      }
      buildRows(keepFocus);
    } catch (e) {
      error('guide load failed', e);
      if (!data) showMessage('Can\'t reach the channel server at ' + (chans.baseUrl() || '(no server)') + '. Start it on your Plex server with: node channels/server.mjs');
    } finally {
      loading = false;
    }
  }

  // --- rendering ------------------------------------------------------------

  function buildRows(keepFocus) {
    const prevCh = rows[rowIndex] && rows[rowIndex].ch.id;
    const prevStart = keepFocus && focus ? focus.start : null;
    track.innerHTML = '';
    rows = data.channels.map((ch, i) => {
      const row = h('div', 'guide-row', track);
      setTransform(row, 'translateY(' + (i * ROW_STEP) + 'px)');
      const cell = h('div', 'guide-chan', row);
      if (ch.logo) {
        const img = h('img', 'guide-logo', cell);
        img.src = ch.logo;
      } else {
        h('div', 'guide-num', cell).textContent = ch.number;
      }
      h('div', 'guide-name', cell).textContent = (ch.logo ? ch.number + '  ' : '') + ch.name;
      const progEl = h('div', 'guide-progs', row);
      return { ch, el: row, progEl, blocks: new Map() };
    });
    const keep = rows.findIndex(r => r.ch.id === prevCh);
    rowIndex = keep >= 0 ? keep : Math.min(rowIndex, Math.max(0, rows.length - 1));
    renderWindow();
    focus = null;
    if (prevStart != null) focus = programs(rows[rowIndex]).find(p => p.start === prevStart) || null;
    if (!focus) focusAt(focusTime);
    render();
  }

  function programs(row) {
    return row ? row.ch.programs : [];
  }

  // Lay out every row's blocks for the current window. Only runs when the
  // window moves or new data arrives, never on a plain focus move.
  function renderWindow() {
    const we = ws + SPAN;
    times.innerHTML = '';
    for (let t = ws; t < we; t += SLOT) {
      const label = h('div', 'guide-time', times);
      setTransform(label, 'translateX(' + Math.round((t - ws) * PX) + 'px)');
      label.textContent = clockTime(t) + (t === ws || new Date(t).getHours() % 12 === 0 && new Date(t).getMinutes() === 0 ? ' ' + ampm(t) : '');
    }
    const now = Date.now();
    rows.forEach(row => {
      row.progEl.innerHTML = '';
      row.blocks = new Map();
      const list = programs(row).filter(p => p.end > ws && p.start < we);
      if (!list.length) {
        h('div', 'guide-prog guide-empty', row.progEl).textContent = 'Nothing scheduled';
        return;
      }
      list.forEach(p => {
        const x0 = Math.max(p.start, ws);
        const x1 = Math.min(p.end, we);
        const b = h('div', 'guide-prog', row.progEl);
        b.style.left = Math.round((x0 - ws) * PX) + 'px';
        b.style.width = Math.max(8, Math.round((x1 - x0) * PX) - 6) + 'px';
        toggleClass(b, 'cont', p.start < ws);
        toggleClass(b, 'live', p.start <= now && now < p.end);
        h('div', 'guide-prog-title', b).textContent = titleOf(p);
        h('div', 'guide-prog-sub', b).textContent = subOf(p);
        row.blocks.set(p, b);
      });
    });
    tick();
  }

  function render() {
    // Keep the focused row on screen.
    if (rowIndex < firstRow) firstRow = rowIndex;
    if (rowIndex >= firstRow + VISIBLE) firstRow = rowIndex - VISIBLE + 1;
    setTransform(track, 'translateY(' + (-firstRow * ROW_STEP) + 'px)');
    rows.forEach((row, i) => {
      toggleClass(row.el, 'current', i === rowIndex);
      row.blocks.forEach((b, p) => toggleClass(b, 'focus', i === rowIndex && p === focus));
    });
    renderInfo();
  }

  function renderInfo() {
    const row = rows[rowIndex];
    if (!focus || !row) {
      setText(infoTitle, row ? row.ch.name : '');
      setText(infoMeta, row ? 'Channel ' + row.ch.number : '');
      setText(infoSummary, '');
      hero.set('');
      return;
    }
    const now = Date.now();
    const live = focus.start <= now && now < focus.end;
    setText(infoTitle, titleOf(focus));
    const parts = [row.ch.number + '  ' + row.ch.name];
    if (focus.type === 'episode') parts.push(episodeLabel({ type: 'episode', parentIndex: focus.season, index: focus.episode }) + '   ' + focus.title);
    else if (focus.year) parts.push(focus.year);
    parts.push(live ? 'On now · ' + Math.max(1, Math.round((focus.end - now) / 60000)) + ' min left'
      : clockTime(focus.start) + ' – ' + clockTime(focus.end) + ' ' + ampm(focus.end));
    setText(infoMeta, parts.join('   ·   '));
    setText(infoSummary, focus.summary || '');
    hero.set(focus.art ? session.server.image(focus.art, 1344, 756) : '');
  }

  // The now line, the clock, and rolling the window forward as time passes.
  function tick() {
    const now = Date.now();
    setText(clockEl, clockTime(now) + ' ' + ampm(now));
    const x = (now - ws) * PX;
    toggleClass(nowLine, 'hidden', x < 0 || x > GRID_W);
    setTransform(nowLine, 'translateX(' + Math.round(GRID_X + x) + 'px)');
    if (slotOf(now) > ws) {
      ws = slotOf(now);
      if (focus && focus.end <= now) focus = null;
      if (data) {
        renderWindow();
        if (!focus) focusAt(now);
        render();
      }
    }
  }

  // --- focus ----------------------------------------------------------------

  // Focus the program in the current row that covers time t (or the next one).
  function focusAt(t) {
    const list = programs(rows[rowIndex]).filter(p => p.end > Date.now());
    focus = list.find(p => p.start <= t && t < p.end) || list.find(p => p.start > t) || list[list.length - 1] || null;
  }

  function moveWindowTo(p) {
    const nowSlot = slotOf(Date.now());
    let next = ws;
    if (p.start >= ws + SPAN - SLOT / 2) next = slotOf(p.start);
    else if (p.start < ws) next = Math.max(nowSlot, slotOf(p.start));
    if (next !== ws) {
      ws = next;
      renderWindow();
      if (ws + SPAN > loadedTo - SLOT) load(true);
    }
  }

  function moveH(dir) {
    const list = programs(rows[rowIndex]);
    const i = list.indexOf(focus);
    const target = list[i + dir];
    if (!target || target.end <= Date.now()) return;
    focus = target;
    focusTime = Math.max(focus.start, Date.now());
    moveWindowTo(focus);
    render();
  }

  function moveV(dir) {
    const next = Math.max(0, Math.min(rows.length - 1, rowIndex + dir));
    if (next === rowIndex) return;
    rowIndex = next;
    focusAt(Math.max(focusTime, ws));
    render();
  }

  async function tuneIn() {
    const row = rows[rowIndex];
    if (!row || tuning) return;
    tuning = true;
    try {
      await tune(row.ch);
    } catch (e) {
      error('tune failed', e);
      setText(infoMeta, 'Couldn\'t tune to ' + row.ch.name + ': ' + (e.message || e));
    } finally {
      tuning = false;
    }
  }

  load();

  return {
    el,
    name: 'guide',
    onShow() {
      ambience.restore();
      tick();
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, 15000);
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => load(true), REFRESH_MS);
      // Back from watching: the schedule has moved on.
      if (data) load(true);
    },
    onHide() {
      clearInterval(tickTimer);
      clearInterval(refreshTimer);
    },
    destroy() {
      clearInterval(tickTimer);
      clearInterval(refreshTimer);
    },
    onKey(action) {
      switch (action) {
        case 'left': moveH(-1); return true;
        case 'right': moveH(1); return true;
        case 'up': moveV(-1); return true;
        case 'down': moveV(1); return true;
        case 'pageup': moveV(-VISIBLE); return true;
        case 'pagedown': moveV(VISIBLE); return true;
        case 'enter': case 'play': case 'playpause':
          if (rows.length) tuneIn(); else load();
          return true;
      }
      return false;
    },
  };
}
