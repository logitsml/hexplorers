// Keyboard shortcuts. Number keys and Space/Enter avoid the camera's WASD/QE/RF/H keys.
//   Space roll · 1 road · 2 settlement · 3 city · 4 dev card · 5–9 the expansions' builds (ship,
//   bridge, warden, wall, foundry: game/builds.ts) · T trade · B bank/harbour
//   Enter end turn · Esc cancel placement / close dialog · M mute · ? rules · Ctrl/⌘+Z take back
//   V flat map · P pause (solo games) · hold . to hurry a presentation along · Space, Enter or Esc
//   skips a game's opening

import { useUI } from '../game/store';
import { session } from './session';
import { toggleView, zoomFlatBy, panFlatBy, fitFlat } from './viewMode';
import { availability, buyDevCard, cancelPlacement, endTurn, openModal, rollDice, toggleBuild, toggleExtraBuild, undoLast } from '../game/commands';
import { EXTRA_HOTKEYS, extraBuilds } from '../game/builds';
import { explain, extraBuildReason, whyNot, type ActionKey } from '../ui/why';
import { closeBack } from '../ui/ModalFrame';
import { setMuted, isMuted } from '../audio/mute';
import { shortcutKey } from './shortcutKey';

const MANDATORY: string[] = ['discard', 'steal', 'gameover'];

export function installShortcuts(): () => void {
  // A button pressed with the pointer lets go of the focus (a click's detail is 0 only for the keyboard),
  // so the shortcuts, Space and Enter above all, still mean the game's and not that button again.
  const onClick = (e: MouseEvent) => {
    const b = e.detail > 0 ? (e.target as HTMLElement | null)?.closest?.('button') : null;
    if (b && !b.closest('[role="dialog"], [aria-modal="true"]')) b.blur();
  };
  window.addEventListener('click', onClick);
  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const store = useUI.getState();
    if (store.screen !== 'game') return;
    const key = shortcutKey(e);
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'z') {
      if (store.modal) return;
      e.preventDefault();
      undoLast();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Held keys don't repeat their shortcut: holding Space or Enter must not roll and then end the
    // turn, nor holding 1 flip build mode on and off.
    if (e.repeat) return;
    // During a game's opening, Space, Enter or Escape hurries the rest of it along (see session.skipIntro).
    if ((key === ' ' || key === 'enter' || key === 'escape') && !store.modal && session.skipIntro()) {
      e.preventDefault();
      return;
    }
    if (key === 'escape') {
      // An open dialog takes the Escape (it closes itself), as does a popover or sheet (it marks the
      // key handled, see ui/hooks.ts's useEscape); the build mode behind it stays.
      if (store.modal || e.defaultPrevented) return;
      cancelPlacement();
      return;
    }
    if (key === '.') {
      store.set({ hurry: true });
      return;
    }
    if (key === 'p' && !store.modal && !session.presenter?.spectating) {
      session.setPaused(!store.paused);
      return;
    }
    if (key === 'm') {
      setMuted(!isMuted());
      return;
    }
    if (key === '?') {
      if (store.modal && MANDATORY.includes(store.modal)) return;
      // (Closing it goes back to the Menu if that's where it was opened, as Escape does.)
      if (store.modal === 'rules') closeBack();
      else store.set({ modal: 'rules' });
      return;
    }
    if (store.modal) return;
    // A refused shortcut says why (the buttons do the same).
    const tell = (ok: boolean | undefined, k: ActionKey) => ok || explain(whyNot(k));
    switch (key) {
      case ' ':
        // Rule: Space on a control the keyboard focused activates that control and does not roll.
        // A button that was merely clicked has been blurred (see installShortcuts), so Space rolls.
        if (focusedControl(el)) return;
        e.preventDefault();
        rollDice();
        break;
      case 'enter':
        if (focusedControl(el)) return;
        // (As Space does: a button that was merely clicked keeps the focus, and would be pressed too.)
        e.preventDefault();
        endTurn();
        break;
      case '1':
        if (store.interaction.kind !== 'road') tell(availability()?.road, 'road');
        toggleBuild('road');
        break;
      case '2':
        if (store.interaction.kind !== 'settlement') tell(availability()?.settlement, 'settlement');
        toggleBuild('settlement');
        break;
      case '3':
        if (store.interaction.kind !== 'city') tell(availability()?.city, 'city');
        toggleBuild('city');
        break;
      case '4':
        tell(availability()?.dev, 'dev');
        buyDevCard();
        break;
      case '5':
      case '6':
      case '7':
      case '8':
      case '9': {
        // (A key whose build isn't in this game does nothing; one that can't be built says why.)
        const b = store.view ? extraBuilds(store.view, store.me).find((x) => EXTRA_HOTKEYS[x.key] === key) : undefined;
        if (!b) break;
        const it = store.interaction;
        if (!(it.kind === 'pick' && it.label === b.label)) {
          const why = extraBuildReason(b).why;
          if (why) {
            explain(why);
            break;
          }
        }
        toggleExtraBuild(b.key);
        break;
      }
      case 't':
        tell(availability()?.main, 'trade');
        openModal('trade');
        break;
      case 'b':
        tell(availability()?.main, 'bank');
        openModal('bank');
        break;
      case 'v':
        toggleView();
        break;
      // (On the flat map, + and - zoom it; elsewhere they do nothing.)
      case '+':
      case '=':
        zoomFlatBy(1.5);
        break;
      case '-':
        zoomFlatBy(1 / 1.5);
        break;
      // (And the arrows move it, once zoomed in: while a piece is being placed they pick its spot
      // instead, see input.ts. 0 shows the whole board again.)
      case 'arrowleft':
        panFlatBy(-1, 0);
        break;
      case 'arrowright':
        panFlatBy(1, 0);
        break;
      case 'arrowup':
        panFlatBy(0, -1);
        break;
      case 'arrowdown':
        panFlatBy(0, 1);
        break;
      case '0':
        fitFlat();
        break;
    }
  };
  // Letting go of "." (or of the window) stops hurrying.
  // (By the key's place too: where "." takes Shift, letting go of Shift first changes the key's character.)
  const onUp = (e: KeyboardEvent) => (e.key === '.' || e.code === 'Period') && useUI.getState().hurry && useUI.getState().set({ hurry: false });
  const onBlur = () => useUI.getState().hurry && useUI.getState().set({ hurry: false });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
  };
}

function focusedControl(el: HTMLElement | null) {
  return !!el?.closest('button, a[href], input, select, [role="button"]') && el.matches(':focus-visible');
}
