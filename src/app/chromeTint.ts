// The browser's own bars take the game's colour. Safari 26 and later (iOS) no longer read
// theme-color (other browsers still do: it's set too). Each of its bars takes its colour from the
// fixed element at the middle of that edge of the viewport, 4 px in (WebKit's
// LocalFrameView::fixedContainerEdges): one spanning 90% of the edge and over 10 px deep gives its
// background colour; failing one, the page's background. The game's 3D canvas is fixed and covers
// the screen, so Safari would find it there, with no colour of its own, and keep whatever it had
// at load. So on a phone a strip lies along each edge, above everything (in index.html, there from the
// first frame; styled in base.css), its background the colour. Safari reads the colour again when
// a strip repaints, so the strips paint, faintly (a strip that paints nothing can change colour
// without Safari noticing, now and then). The iPad and the Mac read a fixed edge once and hold
// it, so they get no strips and follow the page's background instead.
//
// The colour is calm, never an alarm: the title, the sky at the top of its view; in a game, the
// colour of whoever's turn it is as a dusk tone (its hue, half its saturation, all of them at one
// quiet lightness, so a red player's turn reads as brick, not danger), deeper at night and greyer
// in a storm; shadowed while the robber moves; greyed when paused, dimmed under a dialog. It eases
// from one to the next (a transition on the strips and the page), and nothing flashes or pulses.

import * as THREE from 'three/webgpu';
import { useUI, type UIStore } from '../game/store';
import { PLAYER_PALETTE } from '../render/board/pieces';
import type { PlayerColor } from '../engine';
import { session } from './session';

/** The loading chart's sea (index.html paints it before any script). */
const CHART = '#1d5995';
/** The sky at the top of the title's view, by day and at night, and greyed by storm cloud. */
const SKY_DAY = new THREE.Color('#e6f3f5');
const SKY_NIGHT = new THREE.Color('#0d1b2e');
const SKY_STORM = new THREE.Color('#8d9aa2');
const NIGHT = new THREE.Color('#0b1622');
const STORM = new THREE.Color('#3a4650');
const SHADE = new THREE.Color('#100a04');
const SHADOW = new THREE.Color('#0a0c10');
const GREY = new THREE.Color('#4a4f55');
const GOLD = new THREE.Color('#8f7536');

const hsl = { h: 0, s: 0, l: 0 };

/**
 * A player's colour as a dusk tone: its hue at half its saturation and one quiet lightness for
 * every player, so each is told apart by hue alone and none shouts. (White stays legible on it.)
 */
export function turnTone(color: PlayerColor, out = new THREE.Color()): THREE.Color {
  // (In sRGB, as it's seen: three's HSL is in its linear working space by default.)
  out.set(PLAYER_PALETTE[color].ui).getHSL(hsl, THREE.SRGBColorSpace);
  return out.setHSL(hsl.h, Math.min(0.42, hsl.s * 0.5), 0.3, THREE.SRGBColorSpace);
}

const out = new THREE.Color();
const tmp = new THREE.Color();
let shown = '';

function target(ui: UIStore): string {
  if (!ui.worldReady) return CHART;
  const world = session.world;
  const night = world?.time.night.value ?? 0;
  const storm = world?.weather.overcast ?? 0;
  const view = ui.view;
  if (ui.screen !== 'game' || !view) {
    out.copy(SKY_DAY).lerp(SKY_STORM, storm * 0.6).lerp(SKY_NIGHT, night);
  } else {
    if (view.phase === 'gameOver') {
      const won = view.winner === ui.me && !session.presenter?.spectating;
      if (won) out.copy(GOLD);
      else turnTone(view.players[view.winner ?? view.currentPlayer].color, out);
    } else {
      turnTone(view.players[view.currentPlayer].color, out);
      // The robber's moment: the turn's colour in shadow, not a warning.
      if (view.phase === 'moveRobber' || view.phase === 'steal') out.lerp(SHADOW, 0.35);
    }
    out.lerp(tmp.copy(STORM), storm * 0.4).lerp(NIGHT, night * 0.5);
    if (ui.paused) out.lerp(GREY, 0.6);
  }
  if (ui.modal) out.lerp(SHADE, 0.35);
  return `#${out.getHexString()}`;
}

let meta: HTMLMetaElement | null = null;
const edges: HTMLElement[] = [];

function apply() {
  const c = target(useUI.getState());
  if (c === shown) return;
  shown = c;
  for (const e of edges) e.style.setProperty('--edge-tint', c);
  // (The page's background too, for the browsers with no strips; the shorthand, so the loading
  // gradient index.html sets doesn't sit over it.)
  document.documentElement.style.background = c;
  document.body.style.background = c;
  meta ??= document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = c;
}

export function installChromeTint() {
  // (The strips are in index.html, there from the first frame: X's in-app browser stops following
  // strips that come and go, and an iPad keeps what it saw first.)
  edges.push(...document.querySelectorAll<HTMLElement>('.chrome-edge'));
  for (const el of [document.documentElement, document.body]) el.style.transition = 'background-color 0.8s ease';
  // (Twice a second for night and weather, which drift slowly; a turn, a phase or a dialog at
  // once. Nothing while hidden.)
  const tick = () => {
    if (!document.hidden) apply();
  };
  setInterval(tick, 500);
  useUI.subscribe((s, p) => {
    if (s.screen !== p.screen || s.modal !== p.modal || s.flatPhase !== p.flatPhase || s.worldReady !== p.worldReady || s.paused !== p.paused || s.view?.currentPlayer !== p.view?.currentPlayer || s.view?.phase !== p.view?.phase) tick();
  });
}
