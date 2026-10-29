// "Who's watching?" on every launch. Starts on whichever profile was used last.
import { h, toggleClass } from '../util/dom.js';
import { useAmbience } from '../ui/backdrop.js';
import * as profile from '../profile.js';

export function ProfileScreen({ onDone }) {
  const el = h('div', 'screen profiles');
  const ambience = useAmbience();
  h('h1', 'profiles-title', el).textContent = 'Who’s watching?';
  const row = h('div', 'profiles-row', el);

  const tiles = profile.PROFILES.map(p => {
    const tile = h('div', 'profile-tile profile-' + p.id, row);
    const face = h('div', 'profile-face', tile);
    if (p.id === 'kids') h('img', '', face).src = 'img/mascot-512.png';
    else h('img', '', face).src = 'img/mark.png';
    h('div', 'profile-name', tile).textContent = p.label;
    return tile;
  });
  let index = Math.max(0, profile.PROFILES.findIndex(p => p.id === profile.current()));

  function render() {
    tiles.forEach((t, i) => toggleClass(t, 'focus', i === index));
  }
  render();

  return {
    el,
    name: 'profiles',
    onShow() { ambience.restore(); },
    onKey(action) {
      if (action === 'left') { index = Math.max(0, index - 1); render(); return true; }
      if (action === 'right') { index = Math.min(tiles.length - 1, index + 1); render(); return true; }
      if (action === 'enter') { profile.choose(profile.PROFILES[index].id); onDone(); return true; }
      return false;
    },
  };
}
