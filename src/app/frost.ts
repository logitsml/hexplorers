// Where the HUD's glass panels are, for the frost drawn into the frame under them (see
// render/core/frost.ts), and their browser filter taken off while it is: each frame, every panel's
// box on the canvas, its corner and its opacity (one fading in is frosted as faintly); now and then,
// which panels there are and the filter's contrast and brightness (app/glassLight.ts moves them with
// the sky). Only the game's own panels over the island (the expansions' ledger, the phone's status
// line, dock and news lines among them): dialogs, menus, banners and the title keep the browser's filter, as does the flat map
// (and the change to and from it: see `handedBack`), the parchment look (no glass) and More contrast (no blur). `?cssfrost`
// leaves it all to the browser, to compare.

import { useUI } from '../game/store';
import type { World } from '../render/World';
import { FROST_MAX } from '../render/core/frost';
import { repaintGlass } from './glassLight';

const PANELS = '.ui-layer :is(.player-panel, .toolbar, .bank, .logpanel, .hand, .actions, .cdock-panel, .ledger:not(.sheet)).parchment, .ui-layer :is(.status-bar, .cticker li)';

export function frostPanels(world: World) {
  const stage = world.stage;
  const frost = stage.frost;
  const backend = (stage.renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
  // Without WebGPU there is no frost in the frame, and the browser's filter would blur what is
  // behind every panel again each frame the island moves: on a phone, a cost the size of the
  // game's own drawing. So the glass is solid there, as for reduced transparency (styles/glass.css).
  if (!backend?.isWebGPUBackend) {
    document.documentElement.dataset.backdrop = 'solid';
    repaintGlass();
    // (Nothing more to do: the frame never takes the panels over here.)
    return;
  }
  if (new URLSearchParams(location.search).has('cssfrost')) return;
  let panels: HTMLElement[] = [];
  let frame = 0;
  // (Looked for again as soon as the page changes, so a panel that comes up is frosted from its
  // first frame, fading in as it does: between looks it has the browser's filter, which an
  // ancestor's fade blinds, and a game's start can take seconds over thirty frames.)
  let changed = true;
  new MutationObserver(() => (changed = true)).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  const corners = new WeakMap<HTMLElement, number>();
  const take = (el: HTMLElement) => {
    el.style.setProperty('backdrop-filter', 'none');
    el.style.setProperty('-webkit-backdrop-filter', 'none');
  };
  const release = (el: HTMLElement) => {
    el.style.removeProperty('backdrop-filter');
    el.style.removeProperty('-webkit-backdrop-filter');
  };
  const off = () => {
    for (const el of panels) release(el);
    panels = [];
    frost.count.value = 0;
    frost.setActive(false);
  };
  return world.onFrame(() => {
    const root = document.documentElement;
    // The glass is the browser's from the moment the view starts to change, and the frame's again
    // only once the map is gone: handed over once each way, never while the map fades (panels
    // would snap from one frost to the other over a canvas that is covered).
    const ui = useUI.getState();
    const handedBack = ui.viewMode === '3d' && ui.flatPhase === null;
    const on = !!backend?.isWebGPUBackend && root.dataset.look === 'glass' && root.dataset.contrast !== 'more' && ui.screen === 'game' && world.drawEnabled !== false && handedBack;
    if (!on) {
      if (panels.length || frost.count.value) off();
      return;
    }
    if (changed || frame++ % 30 === 0) {
      changed = false;
      const found = [...document.querySelectorAll<HTMLElement>(PANELS)].slice(0, FROST_MAX);
      for (const el of panels) if (!found.includes(el)) release(el);
      for (const el of found) if (!panels.includes(el)) take(el);
      panels = found;
      const style = getComputedStyle(root);
      frost.contrast.value = Number.parseFloat(style.getPropertyValue('--glass-contrast')) || 0.25;
      frost.brightness.value = Number.parseFloat(style.getPropertyValue('--glass-bright')) || 1.65;
    }
    const canvas = stage.canvas.getBoundingClientRect();
    const kx = stage.canvas.width / Math.max(1, canvas.width);
    const ky = stage.canvas.height / Math.max(1, canvas.height);
    let n = 0;
    for (const el of panels) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      let shown = 1;
      for (let p: HTMLElement | null = el; p && shown > 0.01 && !p.classList.contains('ui-layer'); p = p.parentElement) shown *= Number(getComputedStyle(p).opacity);
      if (shown <= 0.01) continue;
      let corner = corners.get(el);
      if (corner === undefined) corners.set(el, (corner = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0));
      // (The corner as drawn: the hand is zoomed to fit, and its box above is too, but not its CSS radius.)
      corner *= (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
      (frost.boxes.array[n] as import('three').Vector4).set((r.left - canvas.left) * kx, (r.top - canvas.top) * ky, (r.right - canvas.left) * kx, (r.bottom - canvas.top) * ky);
      // (A corner wider than half the box is cut to it, as the browser's is: the news lines are pills.)
      (frost.looks.array[n] as import('three').Vector4).set(Math.min(corner, r.width / 2, r.height / 2) * kx, shown, 0, 0);
      n++;
    }
    frost.count.value = n;
    frost.setActive(n > 0);
  });
}
