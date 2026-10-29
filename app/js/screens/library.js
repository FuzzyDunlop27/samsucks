// A whole library as a virtualized poster grid, loaded page by page.
// ▲ from the top row (or Yellow) opens Sort & filter; CH▲/CH▼ jump by letter
// (A–Z sort) or by page. "Family …" sections (kids profile) are loaded whole
// and sorted/filtered here instead of by Plex.
import { h, setText, toggleClass, setTransform } from '../util/dom.js';
import { Grid } from '../ui/grid.js';
import { useAmbience } from '../ui/backdrop.js';
import { session } from '../session.js';
import { prefetch } from '../ui/images.js';
import { isFast } from '../input.js';
import { openItem, playItem } from '../nav.js';
import { error } from '../util/log.js';
import { metaLine } from '../util/format.js';
import { familyItems } from '../profile.js';
import * as store from '../util/store.js';

const PAGE = 140;
// `desc` is each sort's natural direction; choosing it again flips it.
const SORTS = [
  { id: 'titleSort', label: 'Title', desc: false },
  { id: 'addedAt', label: 'Date added', desc: true },
  { id: 'originallyAvailableAt', label: 'Release date', desc: true },
  { id: 'audienceRating', label: 'Rating', desc: true },
];

function sortParam(view) {
  return view.sort + (view.desc ? ':desc' : '');
}

function arrow(sort, desc) {
  if (sort === 'titleSort') return desc ? 'Z–A' : 'A–Z';
  return desc ? '↓' : '↑';
}

// Plex sorts and filters for us, a page at a time.
function plexSource(section, type) {
  return {
    async page(start, size, view) {
      return session.server.items(section.key, start, size, { sort: sortParam(view), type, genre: view.genre && view.genre.key });
    },
    async genres() {
      const mc = await session.server.get('/library/sections/' + section.key + '/genre', { type }, { maxAge: 300000 });
      return (mc.Directory || []).map(d => ({ key: d.key, title: d.title }));
    },
  };
}

// Family stand-in: the whole kid/family subset, sorted and filtered locally.
function familySource(section) {
  let all = null;
  const load = () => all || (all = familyItems(session.server, section).catch(e => { all = null; throw e; }));
  const titleOf = it => (it.titleSort || it.title || '').toLowerCase();
  return {
    async page(start, size, view) {
      let list = (await load()).slice();
      if (view.genre) list = list.filter(it => (it.Genre || []).some(g => g.tag === view.genre.key));
      const key = view.sort;
      list.sort((a, b) => {
        let d;
        if (key === 'titleSort') d = titleOf(a) < titleOf(b) ? -1 : titleOf(a) > titleOf(b) ? 1 : 0;
        else if (key === 'originallyAvailableAt') d = String(a[key] || '').localeCompare(String(b[key] || ''));
        else d = (a[key] || 0) - (b[key] || 0);
        return view.desc ? -d : d;
      });
      return { total: list.length, items: list.slice(start, start + size) };
    },
    async genres() {
      const tags = {};
      (await load()).forEach(it => (it.Genre || []).forEach(g => { tags[g.tag] = 1; }));
      return Object.keys(tags).sort().map(t => ({ key: t, title: t }));
    },
  };
}

export function LibraryScreen(section) {
  const el = h('div', 'screen library');
  const ambience = useAmbience();
  const head = h('header', 'lib-head', el);
  h('h1', 'lib-title', head).textContent = section.title;
  const count = h('div', 'lib-count', head);
  const sortBtn = h('div', 'lib-btn', head);
  const focusInfo = h('div', 'lib-focus', el);
  const hint = h('div', 'lib-hint', el);
  hint.textContent = '▲ Sort & filter   ·   CH ▲▼ Jump';
  const menu = h('div', 'tracks lib-menu hidden', el);

  const type = section.type === 'show' ? 2 : 1;
  const source = section.family ? familySource(section) : plexSource(section, type);
  const viewKey = 'libView.' + (section.family ? 'family.' : '') + section.key;

  // { sort, desc, genre: { key, title } | null }, remembered per library.
  let view = Object.assign({ sort: 'titleSort', desc: false, genre: null }, store.get(viewKey) || {});
  let pages = new Map();     // page -> 'loading' | true
  let items = [];
  let letters = [];          // [{ title: 'A', start: 0 }]
  let generation = 0;
  let zone = 'grid';         // 'grid' | 'head' | 'menu'

  const grid = new Grid({
    top: 200, height: 880, total: 0,
    getItem: i => items[i],
    onFocus: (item, index) => {
      // Warm posters for the row just past the recycled pool.
      if (!isFast()) {
        const start = (Math.floor(index / grid.cols) + grid.poolRows - 1) * grid.cols;
        for (let i = start; i < start + grid.cols; i++) {
          if (items[i]) prefetch(session.server.image(items[i].thumb, 216, 324));
        }
      }
      if (!item) { setText(focusInfo, ''); return; }
      setText(focusInfo, item.title + '   ' + metaLine(item));
      ambience.set(item.UltraBlurColors);
    },
    onSelect: item => openItem(item),
    onNeed: (start, end) => {
      for (let p = Math.floor(start / PAGE); p <= Math.floor(end / PAGE); p++) loadPage(p);
    },
  });
  el.appendChild(grid.el);

  async function loadPage(p) {
    if (pages.has(p)) return;
    if (grid.total && p * PAGE >= grid.total) return;
    pages.set(p, 'loading');
    const gen = generation;
    try {
      const res = await source.page(p * PAGE, PAGE, view);
      if (gen !== generation) return;
      res.items.forEach((it, i) => { items[p * PAGE + i] = it; });
      pages.set(p, true);
      if (grid.total !== res.total) {
        grid.setTotal(res.total);
      } else {
        grid.refresh();
      }
      setText(count, res.total + (section.type === 'show' ? ' shows' : ' movies'));
      if (!res.total) setText(focusInfo, view.genre ? 'Nothing in ' + view.genre.title + '.' : 'Nothing here.');
      if (p === 0 && res.items[0]) grid.onFocus(grid.current());
    } catch (e) {
      pages.delete(p);
      error('library page failed', section.title, p, e);
    }
  }

  async function loadLetters() {
    letters = [];
    if (view.sort !== 'titleSort' || view.desc || section.family) return;
    const gen = generation;
    try {
      const mc = await session.server.get('/library/sections/' + section.key + '/firstCharacter', { type, genre: view.genre && view.genre.key });
      if (gen !== generation) return;
      let start = 0;
      letters = (mc.Directory || []).map(d => {
        const l = { title: d.title, start };
        start += d.size;
        return l;
      });
    } catch (e) { /* letter jump just won't work */ }
  }

  function renderHead() {
    const s = SORTS.find(x => x.id === view.sort) || SORTS[0];
    setText(sortBtn, s.label + ' ' + arrow(s.id, view.desc) + (view.genre ? '  ·  ' + view.genre.title : ''));
    toggleClass(sortBtn, 'focus', zone === 'head');
    toggleClass(grid.ring, 'on', zone === 'grid');
  }

  function reload() {
    generation++;
    pages = new Map();
    items = [];
    store.set(viewKey, view);
    renderHead();
    grid.total = 0;
    grid.index = 0;
    grid.refresh();
    loadPage(0);
    loadLetters();
  }
  reload();

  function jump(dir) {
    if (letters.length) {
      const i = grid.index;
      let li = letters.findIndex((l, k) => i >= l.start && (k === letters.length - 1 || i < letters[k + 1].start));
      li = Math.max(0, Math.min(letters.length - 1, li + dir));
      grid.focusIndex(letters[li].start);
      setText(focusInfo, letters[li].title);
    } else {
      grid.focusIndex(grid.index + dir * grid.cols * 3);
    }
  }

  // --- Sort & filter menu -------------------------------------------------

  let menuCol = 0;
  let menuIndex = [0, 0];
  let menuLists = [[], []];
  let genreList = null;

  function menuOptions() {
    menuLists = [
      SORTS.map(s => ({
        label: s.label + (s.id === view.sort ? '  ' + arrow(s.id, view.desc) : ''),
        sort: s, on: s.id === view.sort,
      })),
      [{ label: 'All genres', genre: null, on: !view.genre }].concat((genreList || []).map(g => ({
        label: g.title, genre: g, on: !!view.genre && view.genre.key === g.key,
      }))),
    ];
  }

  async function openMenu() {
    zone = 'menu';
    menuOptions();
    menuIndex = menuLists.map(l => Math.max(0, l.findIndex(x => x.on)));
    menuCol = 0;
    renderMenu();
    menu.classList.remove('hidden');
    renderHead();
    if (!genreList) {
      try {
        genreList = await source.genres();
      } catch (e) {
        genreList = [];
        error('genres failed', section.title, e);
      }
      if (zone !== 'menu') return;
      menuOptions();
      menuIndex[1] = Math.max(0, menuLists[1].findIndex(x => x.on));
      renderMenu();
    }
  }

  function closeMenu() {
    menu.classList.add('hidden');
    zone = 'grid';
    renderHead();
  }

  function renderMenu() {
    menu.innerHTML = '';
    ['Sort', 'Genre'].forEach((name, c) => {
      const col = h('div', 'tracks-col', menu);
      h('div', 'tracks-head', col).textContent = name;
      const list = h('div', 'lib-menu-list', col);
      let focusRow = null;
      menuLists[c].forEach((opt, i) => {
        const row = h('div', 'tracks-opt', list);
        row.textContent = opt.label;
        toggleClass(row, 'on', opt.on);
        const focused = c === menuCol && i === menuIndex[c];
        toggleClass(row, 'focus', focused);
        if (i === menuIndex[c]) focusRow = i;
      });
      // Long genre lists scroll to keep the focused one in view.
      if (focusRow != null && list.children[focusRow]) {
        const r = list.children[focusRow];
        const room = 780;
        const y = Math.max(0, r.offsetTop + r.offsetHeight - room + 60);
        setTransform(list, 'translateY(' + (-y) + 'px)');
      }
    });
  }

  function chooseMenu() {
    const opt = menuLists[menuCol][menuIndex[menuCol]];
    if (!opt) return;
    if (menuCol === 0) {
      if (opt.sort.id === view.sort) view.desc = !view.desc;
      else { view.sort = opt.sort.id; view.desc = opt.sort.desc; }
    } else {
      view.genre = opt.genre;
    }
    reload();
    menuOptions();
    renderMenu();
  }

  function menuKey(action) {
    switch (action) {
      case 'back': case 'yellow': closeMenu(); return true;
      case 'left': menuCol = 0; break;
      case 'right': menuCol = 1; break;
      case 'up': menuIndex[menuCol] = Math.max(0, menuIndex[menuCol] - 1); break;
      case 'down': menuIndex[menuCol] = Math.min(menuLists[menuCol].length - 1, menuIndex[menuCol] + 1); break;
      case 'pageup': menuIndex[menuCol] = Math.max(0, menuIndex[menuCol] - 8); break;
      case 'pagedown': menuIndex[menuCol] = Math.min(menuLists[menuCol].length - 1, menuIndex[menuCol] + 8); break;
      case 'enter': chooseMenu(); return true;
      default: return true;
    }
    renderMenu();
    return true;
  }

  return {
    el,
    name: 'library',
    onShow() { ambience.restore(); },
    onKey(action) {
      if (zone === 'menu') return menuKey(action);
      if (action === 'yellow') { openMenu(); return true; }
      if (zone === 'head') {
        if (action === 'enter') { openMenu(); return true; }
        if (action === 'down' || action === 'back') { zone = 'grid'; renderHead(); return true; }
        return true;
      }
      switch (action) {
        case 'left': grid.move(-1, 0); return true;
        case 'right': grid.move(1, 0); return true;
        case 'up':
          if (!grid.move(0, -1) && grid.index < grid.cols) { zone = 'head'; renderHead(); }
          return true;
        case 'down': grid.move(0, 1); return true;
        case 'pageup': jump(-1); return true;
        case 'pagedown': jump(1); return true;
        case 'enter': grid.select(); return true;
        case 'play': case 'playpause': if (grid.current()) playItem(grid.current()); return true;
        case 'back':
          if (grid.index > grid.cols * 2) { grid.focusIndex(0); return true; }
          return false;
      }
      return false;
    },
  };
}
