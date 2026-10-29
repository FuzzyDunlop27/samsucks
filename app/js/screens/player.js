// Playback. Direct play whenever the TV can decode the file (hardware, zero
// server load); otherwise ask Plex for HLS with the video passed through and
// only the audio/container converted. Seeking previews locally and only
// commits once the user stops pressing, because AVPlay seeks are slow.
import { DEV } from '../config.js';
import { h, setText, setTransform, toggleClass } from '../util/dom.js';
import { createPlayer } from '../platform/player.js';
import { setScreenSaver, supports4K } from '../platform/tizen.js';
import { session } from '../session.js';
import { clock, episodeLabel, uuid } from '../util/format.js';
import * as icons from '../ui/icons.js';
import * as router from '../router.js';
import { log, warn, error } from '../util/log.js';
import { request } from '../plex/client.js';
import { parseSubtitles, CueTrack } from '../player/subtitles.js';
import * as chans from '../channels/client.js';

// What a 2022 Samsung (Tizen 6.5) decodes natively. No DTS on 2018+ models.
const DIRECT = {
  container: { mp4: 1, m4v: 1, mov: 1, mkv: 1, webm: 1, ts: 1, mpegts: 1, avi: 1 },
  video: { h264: 1, hevc: 1, vp9: 1, av1: 1, mpeg4: 1, mpeg2video: 1, vc1: 1 },
  audio: { aac: 1, ac3: 1, eac3: 1, mp3: 1, mp2: 1, flac: 1, opus: 1, vorbis: 1, pcm: 1 },
};
const TEXT_SUBS = { srt: 1, subrip: 1, ass: 1, ssa: 1, mov_text: 1, vtt: 1, webvtt: 1, smi: 1 };

const OSD_HIDE_MS = 4000;
const SEEK_COMMIT_MS = 900;
const TIMELINE_MS = 10000;
const SURF_ROWS = 6;          // channels visible in the surf list at once
const SURF_STALE_MS = 60000;  // refetch what's on after this long

function clockTime(ms) {
  const d = new Date(ms);
  const mm = d.getMinutes();
  return (d.getHours() % 12 || 12) + ':' + (mm < 10 ? '0' : '') + mm + (d.getHours() >= 12 ? ' PM' : ' AM');
}

function programTitle(p) {
  return p.type === 'episode' ? p.show : p.title;
}

function programSub(p) {
  if (p.type === 'episode') return 'S' + (p.season || 0) + ' E' + (p.episode || 0) + '  ' + p.title;
  return p.year ? String(p.year) : '';
}

function streamsOf(part, type) {
  return (part && part.Stream || []).filter(s => s.streamType === type);
}

function isEmbeddedText(sub) {
  return !!sub && sub.index != null && !sub.key && !!TEXT_SUBS[sub.codec];
}

// External .srt/.ass/.vtt files: we fetch and draw these ourselves.
function isSidecarText(sub) {
  return !!sub && !!sub.key && !!TEXT_SUBS[sub.codec];
}

function subtitleLabel(s) {
  const title = s.displayTitle && s.displayTitle !== 'Unknown' ? s.displayTitle : (s.language || '');
  const kind = (s.codec || '').toUpperCase() + (s.key ? ' · external' : '');
  return title ? title + (s.key ? ' · external' : '') : kind || 'Subtitle';
}

// "4K · HEVC", "1080p · H264" for the OSD.
function videoLabel(media) {
  const r = String(media.videoResolution || '');
  const res = r === '4k' ? '4K' : /^\d+$/.test(r) ? r + 'p' : r.toUpperCase();
  return [res, (media.videoCodec || '').toUpperCase()].filter(Boolean).join(' · ');
}

function cleanSubtitle(text) {
  return String(text || '')
    .replace(/\{\\[^}]*\}/g, '')        // ASS override tags
    .replace(/<[^>]+>/g, '')            // <i>, <font> ...
    .replace(/\\N/g, '\n');
}

// What's on every channel, kept across channel changes so ▼ opens instantly.
let surfCache = { at: 0, lines: [] };

// `channel` (from nav.tune) means we're watching a virtual channel: no watch
// progress is saved, the program ends into whatever the channel airs next,
// and CH ▲/▼ changes channel.
export function PlayerScreen(initial, { offset = null, channel = null } = {}) {
  const el = h('div', 'screen player');
  const stage = h('div', 'player-stage', el);
  const subs = h('div', 'subs', el);
  const spinner = h('div', 'spinner', el);
  const pauseBig = h('div', 'pause-big', el);
  pauseBig.innerHTML = icons.pause;

  const osd = h('div', 'osd', el);
  const osdTop = h('div', 'osd-top', osd);
  if (channel) h('div', 'osd-chan', osdTop).textContent = channel.number + '  ' + channel.name;
  const osdTitle = h('div', 'osd-title', osdTop);
  const osdSub = h('div', 'osd-sub', osdTop);
  const osdBottom = h('div', 'osd-bottom', osd);
  const bar = h('div', 'osd-bar', osdBottom);
  const barFill = h('div', 'osd-fill', bar);
  const knob = h('div', 'osd-knob', bar);
  const seekLabel = h('div', 'osd-seek', knob);
  const times = h('div', 'osd-times', osdBottom);
  const tNow = h('span', 'osd-now', times);
  const tInfo = h('span', 'osd-info', times);
  const tLeft = h('span', 'osd-left', times);
  const hintEl = h('div', 'osd-hint', osdBottom);
  hintEl.innerHTML = channel ? 'CH ▲▼ Change channel   ·   ▼ All channels' : '▼ Audio &amp; subtitles';

  const panel = h('div', 'tracks hidden', el);
  const surf = h('div', 'surf hidden', el);
  const upnext = h('div', 'upnext hidden', el);
  const errorEl = h('div', 'player-error hidden', el);

  let item = initial;
  let media = null;
  let part = null;
  let mode = 'direct';
  let triedFallback = false;
  let base = 0;             // HLS restarts at an offset; AVPlay time is relative to it
  let position = offset || 0;
  let duration = initial.duration || 0;
  let paused = false;
  let started = false;
  let alive = true;
  let audioStream = null;
  let subStream = null;
  let seekTarget = null;
  let seekCount = 0;
  let lastSeekAt = 0;
  let seekTimer = 0;
  let osdTimer = 0;
  let timelineTimer = 0;
  let subTimer = 0;
  let lastText = 0;
  let streamInfo = '';      // resolution and how it's playing, shown next to "Ends at"
  let upnextTimer = 0;
  let nextItem = null;
  let cueTrack = null;
  let cueTimer = 0;
  let cueFor = null;
  const playSession = uuid();

  const player = createPlayer(stage, {
    onTime(ms) {
      if (!started) return;
      position = base + ms;
      if (seekTarget == null) renderProgress(position);
    },
    onBuffering(on) { toggleClass(spinner, 'on', on); },
    onEnd() { finished(); },
    onError(msg) { failed(msg); },
    onSubtitle(text, ms) {
      clearTimeout(subTimer);
      setText(subs, cleanSubtitle(text));
      if (ms > 0) subTimer = setTimeout(() => setText(subs, ''), ms);
    },
  });

  // --- OSD --------------------------------------------------------------

  function renderProgress(ms) {
    const p = duration ? Math.max(0, Math.min(1, ms / duration)) : 0;
    setTransform(barFill, 'scaleX(' + p.toFixed(4) + ')');
    setTransform(knob, 'translateX(' + Math.round(p * 1728) + 'px)');
    const now = Date.now();
    if (now - lastText > 900 || seekTarget != null) {
      lastText = now;
      setText(tNow, clock(ms));
      setText(tLeft, '−' + clock(duration - ms));
      const ends = new Date(now + (duration - ms));
      let hh = ends.getHours();
      const ampm = hh >= 12 ? 'PM' : 'AM';
      hh = hh % 12 || 12;
      const mm = ends.getMinutes();
      setText(tInfo, (streamInfo ? streamInfo + '   ·   ' : '') + 'Ends at ' + hh + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ampm);
    }
  }

  function showOsd(sticky) {
    toggleClass(el, 'osd-on', true);
    clearTimeout(osdTimer);
    if (!sticky && !paused) osdTimer = setTimeout(() => toggleClass(el, 'osd-on', false), OSD_HIDE_MS);
  }

  function hideOsd() {
    clearTimeout(osdTimer);
    toggleClass(el, 'osd-on', false);
  }

  function renderTitles() {
    if (item.type === 'episode') {
      setText(osdTitle, item.grandparentTitle);
      setText(osdSub, episodeLabel(item) + '   ' + item.title);
    } else {
      setText(osdTitle, item.title);
      setText(osdSub, item.year || '');
    }
  }

  // --- Timeline ---------------------------------------------------------

  function report(state) {
    // Channel surfing shouldn't touch Continue Watching or watched state.
    if (!item.ratingKey || channel) return;
    if (DEV && window.__ss && window.__ss.muteTimeline) return;
    session.server.timeline({
      ratingKey: item.ratingKey,
      key: '/library/metadata/' + item.ratingKey,
      state,
      time: Math.floor(position),
      duration: Math.floor(duration),
      'X-Plex-Session-Identifier': playSession,
    });
  }

  function startTimeline() {
    clearInterval(timelineTimer);
    timelineTimer = setInterval(() => report(paused ? 'paused' : 'playing'), TIMELINE_MS);
  }

  // --- Opening ----------------------------------------------------------

  function decideMode() {
    const directOk = DIRECT.container[media.container] && DIRECT.video[media.videoCodec] &&
      (!audioStream || DIRECT.audio[audioStream.codec]);
    const subsOk = !subStream || isEmbeddedText(subStream) || isSidecarText(subStream);
    return directOk && subsOk ? 'direct' : 'hls';
  }

  async function open(atMs) {
    const server = session.server;
    const t0 = Date.now();
    started = false;
    toggleClass(spinner, 'on', true);
    let url;
    let how = 'Direct Play';
    if (mode === 'direct') {
      base = 0;
      url = server.url(part.key);
    } else {
      base = atMs;
      // Burn in only what we can't draw ourselves (image subs, embedded text).
      const burn = subStream && !isSidecarText(subStream);
      url = server.transcodeUrl(item, {
        session: playSession, offsetMs: atMs,
        audioStreamID: audioStream && audioStream.id,
        subtitleStreamID: burn ? subStream.id : undefined,
      });
      // PMS 1.42+ rejects start.m3u8 unless a decision was made for the session first.
      const decision = await request(url.replace('/start.m3u8', '/decision'));
      const mc = decision.MediaContainer || {};
      if (mc.generalDecisionCode && mc.generalDecisionCode >= 2000) throw new Error(mc.generalDecisionText || 'Server refused to convert this file');
      // Video is normally copied and only audio/container converted ("Direct Stream").
      const dm = ((mc.Metadata || [])[0] || {}).Media || [];
      const dp = (dm[0] && dm[0].Part || [])[0];
      const dv = (dp && dp.Stream || []).find(s => s.streamType === 1);
      how = dv && dv.decision === 'transcode' ? 'Transcode' : 'Direct Stream';
    }
    streamInfo = [videoLabel(media), how].filter(Boolean).join(' · ');
    lastText = 0;
    log('play', mode, item.title, media.container + '/' + media.videoCodec + '/' + (audioStream && audioStream.codec), 'at', clock(atMs));
    player.open(url, { uhd: media.videoResolution === '4k' && supports4K() });
    await player.prepare();
    if (!alive) return;
    if (mode === 'direct') {
      applyTracks();
      if (atMs > 0) await player.seek(atMs);
    }
    syncSidecar();
    player.play();
    paused = false;
    started = true;
    position = atMs;
    toggleClass(el, 'paused', false);
    toggleClass(spinner, 'on', false);
    log('playing after ' + (Date.now() - t0) + 'ms (' + mode + ')');
    report('playing');
    startTimeline();
  }

  // Map Plex's chosen streams onto AVPlay's track list (same file order).
  function applyTracks() {
    const t = player.tracks();
    if (audioStream && t.audio.length > 1) {
      const pos = streamsOf(part, 2).indexOf(audioStream);
      if (pos >= 0 && t.audio[pos] != null) player.selectAudio(t.audio[pos]);
    }
    if (isEmbeddedText(subStream)) {
      const pos = streamsOf(part, 3).filter(isEmbeddedText).indexOf(subStream);
      if (pos >= 0 && t.text[pos] != null) player.selectText(t.text[pos]);
    } else {
      player.selectText(null);
      setText(subs, '');
    }
  }

  // Start/stop drawing an external subtitle file for the current selection.
  function syncSidecar() {
    if (!isSidecarText(subStream)) {
      cueTrack = null;
      cueFor = null;
      clearInterval(cueTimer);
      if (!isEmbeddedText(subStream)) setText(subs, '');
      return;
    }
    if (cueFor === subStream) return;
    cueFor = subStream;
    const stream = subStream;
    cueTrack = null;
    fetch(session.server.url(stream.key, { encoding: 'utf-8' }))
      .then(r => r.text())
      .then(text => {
        if (cueFor !== stream || !alive) return;
        cueTrack = new CueTrack(parseSubtitles(text, stream.codec));
        log('subtitles loaded', stream.displayTitle, cueTrack.cues.length + ' cues');
      })
      .catch(e => warn('subtitle fetch failed', e.message));
    clearInterval(cueTimer);
    cueTimer = setInterval(() => {
      if (cueTrack && started) setText(subs, cueTrack.at(base + player.time()));
    }, 120);
  }

  async function start() {
    try {
      const full = await session.server.metadata(item.ratingKey);
      if (!alive) return;
      item = full;
      duration = item.duration || duration;
      media = (item.Media || [])[0];
      part = media && media.Part && media.Part[0];
      if (!part) throw new Error('No playable media');
      const audios = streamsOf(part, 2);
      audioStream = audios.find(s => s.selected) || audios[0] || null;
      subStream = streamsOf(part, 3).find(s => s.selected) || null;
      renderTitles();
      mode = decideMode();
      if (offset == null) offset = item.viewOffset || 0;
      // The channel kept airing while we fetched metadata.
      if (channel) offset = Math.min(offset + Date.now() - channel.tunedAt, Math.max(0, duration - 5000));
      position = offset;
      renderProgress(position);
      showOsd();
      await open(offset);
    } catch (e) {
      failed(e.message || String(e));
    }
  }

  function failed(msg) {
    if (!alive) return;
    if (mode === 'direct' && !triedFallback && media) {
      // The file looked direct-playable but the TV choked: let Plex convert it.
      warn('direct play failed (' + msg + '), falling back to HLS');
      triedFallback = true;
      mode = 'hls';
      open(position).catch(e => failed(e.message));
      return;
    }
    error('playback failed', msg);
    toggleClass(spinner, 'on', false);
    errorEl.classList.remove('hidden');
    setText(errorEl, 'Playback failed: ' + msg);
  }

  // --- Controls ---------------------------------------------------------

  function togglePause() {
    if (!started) return;
    if (paused) {
      player.play();
      paused = false;
      showOsd();
    } else {
      player.pause();
      paused = true;
      showOsd(true);
    }
    toggleClass(el, 'paused', paused);
    report(paused ? 'paused' : 'playing');
  }

  function seekBy(dir) {
    if (!started) return;
    const now = Date.now();
    seekCount = now - lastSeekAt < 700 ? seekCount + 1 : 0;
    lastSeekAt = now;
    const step = seekCount < 3 ? 10000 : seekCount < 8 ? 30000 : seekCount < 16 ? 60000 : 180000;
    const from = seekTarget == null ? position : seekTarget;
    seekTarget = Math.max(0, Math.min(duration - 3000, from + dir * step));
    toggleClass(el, 'seeking', true);
    setText(seekLabel, clock(seekTarget));
    renderProgress(seekTarget);
    showOsd(true);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }

  async function commitSeek() {
    clearTimeout(seekTimer);
    if (seekTarget == null) return;
    const target = seekTarget;
    seekTarget = null;
    toggleClass(el, 'seeking', false);
    showOsd();
    position = target;
    try {
      if (mode === 'direct') {
        toggleClass(spinner, 'on', true);
        await player.seek(target);
        toggleClass(spinner, 'on', false);
        if (paused) togglePause();
      } else {
        await open(target);
      }
    } catch (e) {
      warn('seek failed, reopening', e.message);
      open(target).catch(err => failed(err.message));
    }
  }

  // --- Audio / subtitle picker ------------------------------------------

  let panelCol = 0;
  let panelIndex = [0, 0];
  let panelLists = [[], []];

  function openPanel() {
    const audios = streamsOf(part, 2);
    const texts = streamsOf(part, 3);
    panelLists = [
      audios.map(s => ({ label: s.displayTitle || s.language || 'Track', stream: s, on: s === audioStream })),
      [{ label: 'Off', stream: null, on: !subStream }].concat(texts.map(s => ({ label: subtitleLabel(s), stream: s, on: s === subStream }))),
    ];
    panelIndex = panelLists.map(l => Math.max(0, l.findIndex(x => x.on)));
    panelCol = 0;
    renderPanel();
    panel.classList.remove('hidden');
    hideOsd();
  }

  function renderPanel() {
    panel.innerHTML = '';
    ['Audio', 'Subtitles'].forEach((name, c) => {
      const col = h('div', 'tracks-col', panel);
      const head = h('div', 'tracks-head', col);
      head.innerHTML = c === 0 ? icons.audio : icons.subtitles;
      h('span', '', head).textContent = name;
      panelLists[c].forEach((opt, i) => {
        const row = h('div', 'tracks-opt', col);
        row.textContent = opt.label;
        toggleClass(row, 'on', opt.on);
        toggleClass(row, 'focus', c === panelCol && i === panelIndex[c]);
      });
    });
  }

  async function choose(col, opt) {
    const server = session.server;
    if (col === 0) audioStream = opt.stream;
    else subStream = opt.stream;
    server.selectStreams(part.id, {
      audioStreamID: audioStream ? audioStream.id : undefined,
      subtitleStreamID: subStream ? subStream.id : 0,
    });
    panel.classList.add('hidden');
    const wanted = decideMode();
    if (wanted === 'direct' && mode === 'direct') {
      applyTracks();
      syncSidecar();
    } else if (mode === 'hls' && wanted === 'hls' && col === 1 && isSidecarText(subStream)) {
      syncSidecar();
    } else {
      mode = wanted;
      triedFallback = false;
      await open(position).catch(e => failed(e.message));
    }
  }

  function panelKey(action) {
    if (action === 'back' || action === 'up' && panelIndex[panelCol] === 0) { panel.classList.add('hidden'); return true; }
    if (action === 'left' || action === 'right') panelCol = action === 'left' ? 0 : 1;
    if (action === 'up') panelIndex[panelCol]--;
    if (action === 'down') panelIndex[panelCol] = Math.min(panelLists[panelCol].length - 1, panelIndex[panelCol] + 1);
    if (action === 'enter') {
      const opt = panelLists[panelCol][panelIndex[panelCol]];
      if (opt) choose(panelCol, opt);
      return true;
    }
    renderPanel();
    return true;
  }

  // --- Channel surfing (▼ while watching a channel) ----------------------

  let surfIndex = 0;
  let surfFirst = 0;

  function airing(line, now) {
    return line.programs.find(p => p.start <= now && now < p.end) || null;
  }

  function openSurf() {
    surf.classList.remove('hidden');
    hideOsd();
    const fresh = Date.now() - surfCache.at < SURF_STALE_MS;
    if (surfCache.lines.length) {
      pointAtCurrent();
      renderSurf();
    } else {
      surf.innerHTML = '';
      h('div', 'surf-empty', surf).textContent = 'Loading channels…';
    }
    if (fresh) return;
    const now = Date.now();
    chans.guide(now, now + 3 * 3600e3).then(res => {
      const first = !surfCache.lines.length;
      surfCache = { at: Date.now(), lines: res.channels || [] };
      if (!alive || surf.classList.contains('hidden')) return;
      if (first) pointAtCurrent();
      renderSurf();
    }).catch(e => {
      warn('channel list failed', e.message);
      if (!surfCache.lines.length && alive) setText(surf.firstChild, 'Couldn\'t load channels: ' + e.message);
    });
  }

  function pointAtCurrent() {
    surfIndex = Math.max(0, surfCache.lines.findIndex(l => l.id === channel.id));
    surfFirst = Math.max(0, Math.min(surfIndex - 1, surfCache.lines.length - SURF_ROWS));
  }

  function closeSurf() {
    surf.classList.add('hidden');
  }

  function renderSurf() {
    const lines = surfCache.lines;
    const now = Date.now();
    if (surfIndex < surfFirst) surfFirst = surfIndex;
    if (surfIndex >= surfFirst + SURF_ROWS) surfFirst = surfIndex - SURF_ROWS + 1;
    surf.innerHTML = '';
    const head = h('div', 'surf-head', surf);
    h('span', 'surf-heading', head).textContent = 'Channels';
    h('span', 'surf-clock', head).textContent = clockTime(now);
    if (!lines.length) {
      h('div', 'surf-empty', surf).textContent = 'No channels yet.';
      return;
    }
    const list = h('div', 'surf-list', surf);
    lines.slice(surfFirst, surfFirst + SURF_ROWS).forEach((line, k) => {
      const row = h('div', 'surf-row', list);
      toggleClass(row, 'focus', surfFirst + k === surfIndex);
      h('div', 'surf-num', row).textContent = line.number;
      const body = h('div', 'surf-body', row);
      h('div', 'surf-name', body).textContent = line.name + (line.id === channel.id ? '   ·   Watching' : '');
      const p = airing(line, now);
      h('div', 'surf-title', body).textContent = p ? programTitle(p) : 'Nothing scheduled';
      if (!p) return;
      const left = Math.max(1, Math.round((p.end - now) / 60000));
      h('div', 'surf-sub', body).textContent = [programSub(p), left + ' min left'].filter(Boolean).join('   ·   ');
      const bar = h('div', 'surf-bar', body);
      setTransform(h('i', '', bar), 'scaleX(' + Math.max(0, Math.min(1, (now - p.start) / (p.end - p.start))).toFixed(3) + ')');
    });
    const more = h('div', 'surf-more', surf);
    if (surfFirst > 0) h('span', '', more).textContent = '▲ ' + surfFirst + ' more';
    if (surfFirst + SURF_ROWS < lines.length) h('span', '', more).textContent = '▼ ' + (lines.length - surfFirst - SURF_ROWS) + ' more';
    const f = lines[surfIndex];
    const cur = f && airing(f, now);
    const next = f && f.programs.find(p => p.start >= (cur ? cur.end : now));
    h('div', 'surf-next', surf).textContent = next ? 'Next on ' + f.name + ':   ' + clockTime(next.start) + '   ' + programTitle(next) : '';
    h('div', 'surf-hint', surf).textContent = 'OK Watch   ·   ► Audio & subtitles   ·   Back Close';
  }

  function surfKey(action) {
    const lines = surfCache.lines;
    switch (action) {
      case 'up': case 'down':
        if (lines.length) {
          surfIndex = Math.max(0, Math.min(lines.length - 1, surfIndex + (action === 'up' ? -1 : 1)));
          renderSurf();
        }
        return true;
      case 'enter': {
        const line = lines[surfIndex];
        closeSurf();
        if (!line || line.id === channel.id) return true;
        toggleClass(spinner, 'on', true);
        channel.switchTo(line).catch(e => { warn('channel change failed', e.message); toggleClass(spinner, 'on', false); });
        return true;
      }
      case 'right':
        closeSurf();
        if (part) openPanel();
        return true;
      case 'pageup': case 'pagedown':
        closeSurf();
        return false;
      case 'back': case 'left': case 'stop':
        closeSurf();
        return true;
    }
    return true;
  }

  // --- Ending -----------------------------------------------------------

  async function nextEpisode() {
    const server = session.server;
    const eps = await server.children(item.parentRatingKey);
    const i = eps.findIndex(e => e.ratingKey === item.ratingKey);
    if (i >= 0 && i < eps.length - 1) return eps[i + 1];
    const seasons = (await server.children(item.grandparentRatingKey)).filter(s => s.type === 'season');
    const si = seasons.findIndex(s => s.ratingKey === item.parentRatingKey);
    if (si >= 0 && si < seasons.length - 1) return (await server.children(seasons[si + 1].ratingKey))[0] || null;
    return null;
  }

  async function finished() {
    position = duration;
    report('stopped');
    clearInterval(timelineTimer);
    player.close();
    if (channel) {
      toggleClass(spinner, 'on', true);
      channel.retune().catch(e => { warn('retune failed', e.message); exit(); });
      return;
    }
    if (item.type !== 'episode') { exit(); return; }
    try { nextItem = await nextEpisode(); } catch (e) { nextItem = null; }
    if (!alive) return;
    if (!nextItem) { exit(); return; }
    let left = 10;
    upnext.classList.remove('hidden');
    const render = () => {
      upnext.innerHTML = '';
      h('div', 'upnext-label', upnext).textContent = 'Up next in ' + left;
      h('div', 'upnext-title', upnext).textContent = episodeLabel(nextItem) + '   ' + nextItem.title;
      h('div', 'upnext-hint', upnext).textContent = 'OK to play now · Back to stop';
    };
    render();
    upnextTimer = setInterval(() => {
      left--;
      if (left <= 0) playNext();
      else render();
    }, 1000);
  }

  function playNext() {
    clearInterval(upnextTimer);
    router.replace(PlayerScreen(nextItem, { offset: 0 }));
  }

  function exit() {
    router.back();
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    if (started && position < duration) report('stopped');
    [seekTimer, osdTimer, subTimer].forEach(clearTimeout);
    clearInterval(timelineTimer);
    clearInterval(upnextTimer);
    clearInterval(cueTimer);
    player.destroy();
    if (mode === 'hls') session.server.stopTranscode(playSession);
    document.documentElement.classList.remove('playing');
    setScreenSaver(true);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  function onVisibility() {
    if (document.hidden) {
      if (started && !paused) togglePause();
      player.suspend();
    } else {
      player.restore();
    }
  }

  return {
    el,
    name: 'player',
    onShow() {
      document.documentElement.classList.add('playing');
      setScreenSaver(false);
      document.addEventListener('visibilitychange', onVisibility);
      renderTitles();
      if (!started) start();
    },
    onKey(action) {
      if (!upnext.classList.contains('hidden')) {
        if (action === 'enter') { playNext(); return true; }
        if (action === 'back' || action === 'stop') { exit(); return true; }
        return true;
      }
      if (!panel.classList.contains('hidden')) return panelKey(action);
      if (!surf.classList.contains('hidden') && surfKey(action)) return true;
      switch (action) {
        case 'enter':
          if (seekTarget != null) commitSeek();
          else if (el.classList.contains('osd-on') || paused) togglePause();
          else showOsd();
          return true;
        case 'playpause': if (seekTarget != null) commitSeek(); else togglePause(); return true;
        case 'play': if (paused) togglePause(); return true;
        case 'pause': if (!paused) togglePause(); return true;
        case 'left': case 'rw': seekBy(-1); return true;
        case 'right': case 'ff': seekBy(1); return true;
        case 'up': case 'info': showOsd(); return true;
        case 'down':
          if (channel) openSurf();
          else if (part) openPanel();
          return true;
        case 'pageup': case 'pagedown':
          if (channel) {
            toggleClass(spinner, 'on', true);
            channel.surf(action === 'pageup' ? 1 : -1).catch(e => { warn('channel change failed', e.message); toggleClass(spinner, 'on', false); });
          }
          return true;
        case 'stop': exit(); return true;
        case 'back':
          if (seekTarget != null) { seekTarget = null; toggleClass(el, 'seeking', false); renderProgress(position); showOsd(); return true; }
          if (el.classList.contains('osd-on') && !paused) { hideOsd(); return true; }
          exit();
          return true;
      }
      return true;
    },
    onHide() {},
    destroy: teardown,
  };
}
