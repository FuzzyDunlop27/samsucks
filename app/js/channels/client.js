// Talks to the channel server (channels/server.mjs) that runs next to Plex.
// It holds channel setup and schedules; we only ask what's on and play the
// file straight from Plex.
import { request } from '../plex/client.js';
import { session } from '../session.js';
import * as store from '../util/store.js';

export const DEFAULT_PORT = 32500;

// Same machine as Plex unless set otherwise. plex.direct hostnames encode the
// LAN IP (192-168-1-10.<hash>.plex.direct), and the channel server is plain http.
export function baseUrl() {
  const saved = store.get('channelsUrl');
  if (saved) return saved;
  if (!session.server) return '';
  let host = '';
  try { host = new URL(session.server.uri).hostname; } catch (e) { return ''; }
  const direct = host.match(/^(\d+-\d+-\d+-\d+)\..*\.plex\.direct$/);
  if (direct) host = direct[1].replace(/-/g, '.');
  return 'http://' + host + ':' + DEFAULT_PORT;
}

function get(path, params) {
  const token = session.server && session.server.token;
  return request(baseUrl() + path, { token, params, timeout: 8000 });
}

let channelList = null;

export async function channels() {
  const res = await get('/api/channels');
  channelList = res.channels || [];
  return channelList;
}

export function guide(from, to) {
  return get('/api/guide', { from, to });
}

export function nowOn(id) {
  return get('/api/channels/' + encodeURIComponent(id) + '/now');
}

// The channel `dir` steps away from `id`, wrapping around (CH ▲ / CH ▼).
export async function neighbor(id, dir) {
  const list = channelList || await channels();
  if (!list.length) return null;
  const i = list.findIndex(c => c.id === id);
  return list[(i + dir + list.length) % list.length];
}
