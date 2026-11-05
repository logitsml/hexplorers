// The tab icon follows the game: loading, whose turn it is, the dice as they tumble and land, a
// piece just built, an offer waiting on you (its rim counting down), a pause, the winner. It is
// redrawn only when what it shows changes, and animates only while the tab is visible and motion
// is welcome; otherwise each state shows as a still.

import { useUI, animSpeed, type UIStore } from '../game/store';
import { PLAYER_PALETTE } from '../render/board/pieces';
import { reducedMotion } from './display';
import { loadDisplayFont, session } from './session';
import { TUMBLE, paintFavicon, type FaviconArt } from './faviconArt';

const FPS = 12;
/** The states that animate (the rest show their still: see frame). */
const LIVELY = new Set<FaviconArt['kind']>(['rolling', 'built']);
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** How long a piece you built shows on the icon. */
const BUILT_FOR = 1.6;
/** States that move, and the moment of each that stands in as a still. */
const STILL: Partial<Record<FaviconArt['kind'], number>> = { roll: 0, rolling: 9, thinking: 1.15, place: 0, built: 9, won: 0.4 };

type Built = { what: 'road' | 'settlement' | 'city'; at: number };

/** Count your pieces, to notice one being added. */
function pieces(s: UIStore) {
  const v = s.view!;
  let settlement = 0, city = 0, road = 0;
  for (const b of v.buildings) if (b?.owner === s.me) b.kind === 'city' ? city++ : settlement++;
  for (const r of v.routes) if (r?.owner === s.me) road++;
  return { settlement, city, road };
}

function pick(s: UIStore, built: Built | null, now: number): FaviconArt {
  const v = s.view;
  if (!s.worldReady) return { kind: 'loading', progress: s.loading.progress };
  if (s.screen !== 'game' || !v) {
    // The title's "Setting sail" bar, while a game is being prepared.
    if (s.loading.label === 'Setting sail' && s.loading.progress < 1) return { kind: 'loading', progress: s.loading.progress };
    return { kind: 'brand' };
  }
  const color = (p: number) => PLAYER_PALETTE[v.players[p].color].ui;
  if (s.replay) return { kind: 'replay', progress: s.replay.total ? s.replay.index / s.replay.total : 0 };
  if (v.phase === 'gameOver') return v.winner === s.me ? { kind: 'won' } : { kind: 'lost', color: color(v.winner ?? v.currentPlayer) };
  if (s.paused) return { kind: 'paused' };
  if (s.offerClock) return { kind: 'offer', left: s.offerClock.total ? s.offerClock.left / s.offerClock.total : 1 };
  if (built && now - built.at < BUILT_FOR * 1000) return { kind: 'built', color: color(s.me), what: built.what };
  const roll = s.diceRoll;
  if (roll) {
    const total = roll.dice[0] + roll.dice[1];
    // The throw plays out (its id is when it was thrown); the number then stays for the rest of
    // that turn (the view can still say "roll" while the throw is being shown).
    if (now - roll.id < ((TUMBLE + 0.35) * 1000) / animSpeed()) return { kind: 'rolling', color: color(roll.player), total };
    if (roll.player === v.currentPlayer && !v.phase.startsWith('setup')) return { kind: 'rolled', color: color(roll.player), total };
  }
  const mine = v.currentPlayer === s.me && !session.presenter?.spectating;
  if ((v.phase === 'setupSettlement' || v.phase === 'setupRoad') && mine && s.interaction.kind.startsWith('setup')) return { kind: 'place', color: color(s.me) };
  if (v.phase === 'roll' && mine) return { kind: 'roll', color: color(s.me) };
  return { kind: 'thinking', color: color(v.currentPlayer) };
}

/** What makes two states draw the same (progress and countdowns in steps a 64 px icon can show). */
function keyOf(a: FaviconArt) {
  switch (a.kind) {
    case 'loading':
    case 'replay':
      return `${a.kind}:${Math.round(a.progress * 48)}`;
    case 'offer':
      return `offer:${Math.round(a.left * 48)}`;
    default:
      return JSON.stringify(a);
  }
}

export function installFavicon() {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  // (Kept in main memory: a canvas on the GPU makes each encode wait for the GPU to read it back,
  // behind the island's frames, which in Chrome held the page for 30 ms and more each time.)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let key = '';
  let since = 0;
  let painted = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let built: Built | null = null;
  let counts: ReturnType<typeof pieces> | null = null;

  const frame = () => {
    timer = null;
    const s = useUI.getState();
    const now = Date.now();
    const art = pick(s, built, now);
    const k = keyOf(art);
    if (k !== key) {
      key = k;
      since = now;
    }
    const t = (now - since) / 1000;
    // Only the short-lived states move (the dice tumbling, a piece landing): the long ones (a bot
    // thinking, your roll waiting) show a still, so the icon isn't repainted and re-encoded twelve
    // times a second for most of a game. On a touch device, where no tab icon is in sight, none move.
    const moving = art.kind in STILL && LIVELY.has(art.kind) && !coarse;
    const animate = moving && !document.hidden && !reducedMotion();
    const at = animate ? t : (STILL[art.kind] ?? 0);
    const id = animate ? `${k}@${Math.floor(t * FPS)}` : k;
    if (id !== painted) {
      painted = id;
      paintFavicon(ctx, art, at);
      link.type = 'image/png';
      link.href = canvas.toDataURL('image/png');
    }
    // A moving state keeps ticking; the dice and a new piece also end on their own.
    if (animate) timer = setTimeout(frame, 1000 / FPS);
    else if (art.kind === 'rolling' || art.kind === 'built') timer = setTimeout(frame, 250);
  };
  const soon = () => {
    if (timer === null) timer = setTimeout(frame, 0);
  };

  useUI.subscribe((s, p) => {
    if (s.view !== p.view || s.me !== p.me) {
      if (!s.view || s.screen !== 'game') counts = null;
      else {
        const c = pieces(s);
        // A piece more of yours than a moment ago (not a whole game appearing at once).
        if (counts) {
          const what = c.city > counts.city ? 'city' : c.settlement > counts.settlement ? 'settlement' : c.road > counts.road ? 'road' : null;
          if (what) built = { what, at: Date.now() };
        }
        counts = c;
      }
    }
    if (timer !== null) clearTimeout(timer);
    timer = null;
    soon();
  });
  document.addEventListener('visibilitychange', soon);
  // The numbers are drawn in the display font: once it has loaded, draw them again.
  void loadDisplayFont().then(() => {
    painted = '';
    soon();
  });
  soon();
}
