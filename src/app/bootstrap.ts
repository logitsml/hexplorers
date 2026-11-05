// App start-up: create the persistent 3D world, then show the title screen
// (or jump straight into a game with ?autostart / an all-bot game with ?watch,
// or aboard an online room from its link).

import { loadDisplayFont, loadGameParts, session } from './session';
import { animatorSpeed, flushSettings, useUI } from '../game/store';
import type { Quality } from '../render/core/stage';
import { sfx } from '../audio/sfx';
import { applyVolume } from '../audio/mute';
import { installShortcuts } from './keys';
import { applyDisplaySettings, reducedMotion } from './display';
import { bindBrightPieces } from '../render/World';
import { deviceQuality, rememberedFloor, rememberedQuality } from './deviceQuality';
import { watchQuality } from './autoQuality';
import { watchResolution } from './autoResolution';
import { frostPanels } from './frost';
import * as mapFit from './mapFit';
import { installFavicon } from './favicon';
import { installChromeTint } from './chromeTint';
import { installGlassLight } from './glassLight';
import { arrival } from './links';
import { probeGpu, settleGpu } from '../render/core/gpuProbe';
import { EXPANSIONS, PRESETS, mixOf, type Expansion } from '../engine/presets';

/** Show a start-up step on the loading screen (progress 0..1) and let it paint before going on. */
async function step(label: string, progress: number) {
  performance.mark(`load: ${label}`);
  useUI.getState().set({ loading: { label, progress } });
  // (A hidden tab gets no animation frames, so a timer stands in rather than stalling the load.)
  await new Promise((r) => {
    requestAnimationFrame(() => setTimeout(r, 0));
    setTimeout(r, 50);
  });
}

/**
 * The menu page a `?go=` path names: /new the singleplayer set-up (with `?mix=`, a preset's id or
 * expansions joined by commas), /multi the Multiplayer page. Null for anything else (a room's link is openLink's).
 */
export function goPage(go: string): { page: 'solo' | 'multi'; mix?: string[] } | null {
  if (!go.startsWith('/')) return null;
  const [path, query = ''] = go.split('#')[0].split('?');
  const p = path.replace(/\/+$/, '');
  if (p === '/multi') return { page: 'multi' };
  if (p !== '/new') return null;
  const named = new URLSearchParams(query).get('mix');
  const mix = named ? (PRESETS.find((x) => x.id === named)?.expansions ?? named.split(',').filter((e): e is Expansion => EXPANSIONS.some((x) => x.id === e))) : [];
  return { page: 'solo', ...(mix.length && { mix: [...mix] }) };
}

/** The address without its `?go=` once the page it asked for is open (a reload comes back to the title). */
function tidyGo() {
  try {
    const params = new URLSearchParams(location.search);
    params.delete('go');
    const qs = params.toString();
    history.replaceState(history.state, '', `/${qs ? `?${qs}` : ''}${location.hash}`);
  } catch {
    /* (a sandboxed frame: the address stays as it was) */
  }
}

/** Go aboard the room the page was opened for, if its link names one (the address is tidied either way). */
async function openLink() {
  try {
    const { linkFrom, replayFrom, profileFrom, showRoomInUrl } = await import('../online/links');
    // (A replay's link plays it back.)
    const replay = replayFrom(location);
    if (replay) return void (await import('../ui/online/replay/openReplay')).openReplay(replay);
    const link = linkFrom(location);
    // (A profile, /u/HANDLE: it opens over the Multiplayer page.)
    const handle = link ? null : profileFrom(location);
    if (handle) void import('../online/account').then((m) => m.showProfile(handle));
    // (Not a room, or a link the app doesn't follow yet: the address goes back to the start.)
    if (!link) return showRoomInUrl(null);
    // (A seat handed over from another device: its token is taken from the fragment, which the
    // join clears from the address.)
    await session.join(link.code, { watch: link.watch, seat: link.seat });
  } catch (e) {
    console.error('could not open the link', e);
  }
}

export async function bootstrap() {
  try {
    await start();
  } catch (e) {
    console.error('could not start', e);
    const { loading } = useUI.getState();
    useUI.getState().set({ loading: { ...loading, error: e instanceof Error ? e.message : String(e) } });
  }
}

async function start() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  // (The GPU device is asked for at once: it is on its way while the rest starts.)
  void probeGpu();
  const params = new URLSearchParams(location.search);
  const store = useUI.getState();
  const q = params.get('q');
  // ?q= for testing; Auto picks for the device (or what it settled on here before).
  const quality: Quality =
    q === 'low' || q === 'medium' || q === 'high' || q === 'ultra' ? q : store.settings.quality === 'auto' ? (rememberedQuality() ?? (await deviceQuality())) : store.settings.quality;
  store.set({ quality });
  applyDisplaySettings(store.settings);
  // The display font loads alongside start-up; only a game's board view waits for it.
  loadDisplayFont();
  // The tab icon shows the loading, then the game as it goes.
  installFavicon();
  // The browser's bar (iOS Safari's) takes the colour at the top of the view.
  installChromeTint();
  installGlassLight();
  // Browsers only allow audio after a user gesture (on touch, the lift counts, not the press),
  // and the system can take it away again (a call, another app): every gesture asks until it runs.
  const unlock = () => {
    if (!sfx.isRunning()) sfx.unlock();
  };
  for (const ev of ['pointerup', 'click', 'keydown', 'touchend'] as const) window.addEventListener(ev, unlock, { passive: true });
  await step('Sharpening the quills', 0.12);
  // (Whether WebGPU runs the game here, decided before the renderer takes the canvas.)
  await settleGpu();
  const world = await session.initWorld(canvas, quality, step);
  // (Lost while the renderer was starting, before anyone was listening: nothing would be drawn.)
  if (world.stage.lost) throw new Error('The graphics device was lost.');
  world.animator.speed = animatorSpeed();
  // The graphics device gone (a driver reset, memory pressure): keep the game, ask for a reload.
  world.onDeviceLost = (message) => {
    session.flushSave();
    flushSettings();
    const saved = useUI.getState().screen === 'game' ? ' Your game is saved: it carries on from here after a reload.' : '';
    useUI.getState().set({ worldReady: false, modal: null, loading: { label: '', progress: 0, error: `${(message || 'The graphics device was lost').replace(/\.$/, '')}.${saved}`, lost: true } });
  };
  // Hurrying (a held key, a skipped opening, or online catching up) or pausing changes the animations' pace straight away.
  useUI.subscribe((s, p) => {
    if (s.hurry !== p.hurry || s.introSkip !== p.introSkip || s.catchUp !== p.catchUp || s.paused !== p.paused || s.settings.animationSpeed !== p.settings.animationSpeed) world.animator.speed = animatorSpeed();
  });
  world.setTimeMode(store.settings.timeOfDay);
  world.time.snap();
  world.stage.setMotionBlur(store.settings.motionBlur && !reducedMotion());
  world.stage.setBlur(store.settings.blur);
  world.weather.setMode(store.settings.weather);
  world.weather.gentle = reducedMotion;
  world.rig.calm = reducedMotion;
  bindBrightPieces(() => useUI.getState().settings.brightPieces);
  world.rig.onHomeChange = (off) => useUI.getState().set({ cameraOffHome: off });
  // (Where Auto lowered the resolution before, it starts there.)
  if (store.settings.quality === 'auto') world.stage.setFloorScale(rememberedFloor() ?? 1);
  watchQuality(world);
  watchResolution(world);
  frostPanels(world);
  mapFit.startMapFit(world);
  if (params.has('time') && Number.isFinite(Number(params.get('time')))) world.time.freeze(Number(params.get('time')));
  applyVolume();
  installShortcuts();
  // Don't lose the last move when the tab closes inside the save debounce. Mobile browsers often
  // drop a background tab without a pagehide, so hiding saves too, and while hidden the game
  // holds (no bot moves unseen) and the sound stops.
  window.addEventListener('pagehide', () => {
    session.flushSave();
    flushSettings();
  });
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden;
    if (hidden) {
      session.flushSave();
      flushSettings();
    }
    session.presenter?.hold('hidden', hidden);
    sfx.setHidden(hidden);
    // (Back from another app or tab, Safari may show the 3D view blank until it's nudged: see refreshSurface.)
    // (Not while shaders build for a quality change: a resize then would blank the frame kept
    // under its veil.)
    if (!hidden && !useUI.getState().qualityProgress && !session.world?.compiling) session.world?.stage.refreshSurface();
  });
  window.addEventListener('pageshow', (e) => e.persisted && session.world?.stage.refreshSurface());
  if (import.meta.env.DEV) Object.assign(window, { session, __ui: useUI, __fit: mapFit });
  // The title's sea turns at an easy 30 frames a second behind the menu (see World.idling).
  world.titleIdle = useUI.getState().screen === 'title';
  useUI.subscribe((s) => (world.titleIdle = s.screen === 'title'));
  // A game's milestones on the page's timeline, for profiling a production build: its board on
  // screen, and the moment play is handed over once the island has risen.
  let starting = false;
  useUI.subscribe((s, p) => {
    if (s.screen === 'game' && p.screen !== 'game') {
      performance.mark('game: shown');
      starting = true;
    } else if (starting && !s.busy && p.busy) {
      performance.mark('game: playable');
      starting = false;
    }
  });
  const seed = params.get('seed') && Number.isFinite(Number(params.get('seed'))) ? Math.floor(Math.abs(Number(params.get('seed')))) >>> 0 : undefined;
  // (The watch link, /watch, is ?watch: see links.ts.)
  const watch = params.has('watch') || arrival.watch;
  if (watch || params.has('autostart')) {
    // ?mix= a preset's id (allHands) or expansions joined by commas (sea,oil): the mix's map, knobs and target.
    const named = params.get('mix');
    const chosen = named ? (PRESETS.find((p) => p.id === named)?.expansions ?? named.split(',').filter((e): e is Expansion => EXPANSIONS.some((x) => x.id === e))) : [];
    const mix = chosen.length ? mixOf(chosen) : null;
    await step('Land ho!', 1);
    store.set({ worldReady: true });
    world.stage.refreshSurface();
    await session.start({
      ...(mix?.playable && { modules: mix.modules, map: mix.map === 'classic' ? undefined : mix.map, knobs: mix.knobs, victoryPoints: mix.target }),
      name: 'You',
      color: 'red',
      opponents: 3,
      difficulty: (['easy', 'normal', 'hard'] as const).find((d) => d === params.get('difficulty')) ?? 'normal',
      layout: params.get('layout') === 'beginner' ? 'beginner' : 'random',
      numberPlacement: 'spiral',
      seed,
      watch,
    });
    return;
  }
  await step('Sketching the coastline', 0.48);
  // Its shaders compile before the first frame (in slices, then side by side on the GPU); the
  // title waits until frames run evenly. Its board has no island (World.deferIsland): the title
  // shows only the sea over where one would wait.
  world.deferIsland = true;
  let audio = false;
  await session.showcase(seed ?? 11, (done, total) => {
    if (!total) return;
    useUI.getState().set({ loading: { label: 'Inking the island', progress: 0.55 + (0.4 * done) / total } });
    // Once every shader has been asked for, the page only waits on the GPU: a quiet moment to
    // open the audio device, which blocks for a few hundred milliseconds (see sfx.prepare).
    if (!audio && done * 2 >= total) {
      performance.mark('load: shaders requested');
      audio = true;
      setTimeout(() => sfx.prepare(), 0);
    }
  });
  performance.mark('load: shaders compiled');
  await world.settled();
  await step('Land ho!', 1);
  // A page of the menu a link asks for (the installed app's shortcuts, the 404 page's ?go=) opens
  // as the title comes up.
  // (The dev server, and the Worker, serve the page at /new themselves.)
  const go = params.get('go') ?? (goPage(location.pathname) ? location.pathname : null);
  const page = go === null ? null : goPage(go);
  if (page) {
    store.set({ goPage: page });
    tidyGo();
  }
  store.set({ worldReady: true });
  world.stage.refreshSurface();
  performance.mark('load: title');
  // A room's link (/r/CODE to join, /w/CODE to watch, or the static site's 404 page sending one on
  // as /?go=): its harbour opens over the title, and a profile's (/u/HANDLE) over the Multiplayer
  // page. (The online code is fetched only then.)
  if (!page && (/^\/([rwu]|replay)(\/|$)/.test(location.pathname) || go !== null)) void openLink();
  // For those who turned notifications on: a tapped one takes this page to its room.
  if ('Notification' in window && Notification.permission === 'granted') void import('../online/notifications').then((m) => m.followNotifications(), () => {});
  // (After the loading chart's dive into the title, which it would only make uneven.)
  setTimeout(() => {
    // (A failure here is no news: a game's start asks again, and says so if it fails.)
    loadGameParts().catch(() => {});
    // The terrain's workers start meanwhile (their script, off the main thread), so the first
    // island isn't kept waiting for them.
    world.warmTerrain();
    // A device that has not compiled this build's game shaders yet does so now, out of sight, while
    // the player chooses (a first visit's Set sail was half a minute at 94%): see Session.warmShaders.
    // (Not under automation, whose title would sink and rise: add ?warm to try it.)
    if (!navigator.webdriver || params.has('warm')) setTimeout(() => session.warmShaders(), 2000);
  }, 1000);
}
