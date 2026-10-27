// Where selecting things goes. Kept in one place so screens don't import each other.
import * as router from './router.js';
import * as chans from './channels/client.js';
import { DetailScreen } from './screens/detail.js';
import { GuideScreen } from './screens/guide.js';
import { LibraryScreen } from './screens/library.js';
import { PlayerScreen } from './screens/player.js';
import { SearchScreen } from './screens/search.js';
import { SettingsScreen } from './screens/settings.js';

export function openItem(item) {
  if (item.type === 'clip') { playItem(item); return; }
  router.push(DetailScreen(item));
}

export function playItem(item, opts) {
  if (item.type === 'show' || item.type === 'season') {
    // Play on a show means "the next episode"; the detail screen resolves it.
    router.push(DetailScreen(item, { autoplay: true }));
    return;
  }
  router.push(PlayerScreen(item, opts || {}));
}

export function openLibrary(section) {
  router.push(LibraryScreen(section));
}

export function openSearch() {
  router.push(SearchScreen());
}

export function openSettings() {
  router.push(SettingsScreen());
}

export function openGuide() {
  router.push(GuideScreen());
}

// Tune to a virtual channel: play whatever is on now, from where the channel
// is now. The player calls back here when the program ends or on CH ▲/▼.
export async function tune(channel, { replace = false } = {}) {
  const on = await chans.nowOn(channel.id);
  const p = on.program;
  const item = {
    ratingKey: p.key, type: p.type, title: p.title, year: p.year, duration: p.duration,
    grandparentTitle: p.show, parentIndex: p.season, index: p.episode,
  };
  const ch = Object.assign({}, on.channel, {
    tunedAt: Date.now(),
    retune: () => tune(on.channel, { replace: true }),
    surf: async dir => {
      const next = await chans.neighbor(on.channel.id, dir);
      if (next) await tune(next, { replace: true });
    },
    switchTo: other => tune(other, { replace: true }),
  });
  const screen = PlayerScreen(item, { offset: on.offset, channel: ch });
  if (replace) router.replace(screen);
  else router.push(screen);
}
