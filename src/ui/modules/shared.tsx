// What the expansions' own panels share: making a move, a pick on the board, a seat's name with
// its mark, and the little counters they draw. Moves go through the presenter like every other
// (queued while a presentation runs), and only ever moves legalActions listed.

import type { Action, GameState, PlayerId } from '../../engine';
import { useUI, type Interaction, type Settings } from '../../game/store';
import { session } from '../../app/session';
import { spotOf, stagedAsk, stagedStep, stagesOf, type SpotKind } from '../../game/moduleActions';
import { PLAYER_PALETTE } from '../../render/board/pieces';
import { sfx } from '../../audio/sfx';
import { SeatMark } from '../SeatMark';
import { explain } from '../why';

/** Make a move: the reason it was refused goes to the error bar; a pick or list it ended is put away. */
export function act(a: Action) {
  // (The presenter answers null for a move made, so a missing presenter can't be told by `??`.)
  const p = session.presenter;
  const err = p ? p.act(a) : 'No game in progress';
  if (err) explain(err);
  else sfx.play('click');
  const it = useUI.getState().interaction;
  useUI.getState().set({ choice: null, ...(it.kind === 'pick' ? { interaction: { kind: 'idle' } as Interaction } : {}) });
  session.presenter?.syncMarkers();
}

/** What to choose on the board, by the kind of spot (corners and edges glow; a hex lights as it's hovered). */
export const SPOT_WORDS: Record<SpotKind, string> = { vertex: 'a glowing corner', edge: 'a glowing edge', hex: 'a hex' };

/** Ask for a spot on the board: each glowing spot stands for the moves made there. */
export function startPick(label: string, target: SpotKind, actions: Action[], hint = `${label}: choose ${SPOT_WORDS[target]} on the board`) {
  const spots = [...new Set(actions.map((a) => spotOf(a, target)).filter((v) => v >= 0))];
  useUI.getState().set({ interaction: { kind: 'pick', target, spots, label, actions }, choice: null, hint });
  session.presenter?.syncMarkers();
  sfx.play('click');
}

/**
 * Ask for a staged pick on the board (`stagesOf`): sets of spots chosen in turn, each stage lit as
 * it comes, the move made when the last is chosen (or at once, when no stage leaves a choice).
 */
export function startStagedPick(label: string, actions: Action[]) {
  const step = actions.length ? stagedStep(actions, [[]]) : null;
  if (!step) return;
  if (step.done) return act(step.done);
  const target = stagesOf(actions[0])!.kind;
  useUI.getState().set({ interaction: { kind: 'pick', target, spots: step.spots, label, actions, chosen: step.chosen }, choice: null, hint: `${label}: ${stagedAsk(actions[0].type, step)}` });
  session.presenter?.syncMarkers();
  sfx.play('click');
}

/** Change a setting from where it applies (the pacing defaults' switches; Settings holds them too). */
export const setSetting = (p: Partial<Settings>) => useUI.getState().set({ settings: { ...useUI.getState().settings, ...p } });

/** A pacing default's switch (game/pacing.ts), where the decision it answers is made. */
export function PaceSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="pace-switch">
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Put a pick away. */
export function endPick() {
  useUI.getState().set({ interaction: { kind: 'idle' }, choice: null });
  session.presenter?.syncMarkers();
}

/** Watching a replay or a game of bots: the panels show the table but offer nothing to do. */
export const useWatching = (): boolean => useUI((s) => s.replay !== null) || !!session.presenter?.spectating;

/** The label of the pick under way, if one is. */
export const usePicking = (): string | null => useUI((s) => (s.interaction.kind === 'pick' ? s.interaction.label : null));

/**
 * The kind of spot the moves are made at, when they differ only in that spot (a venture's hex, a
 * road to crack), so choosing one is a pick on the board; null when they differ in anything else.
 */
export function pickTarget(actions: Action[]): SpotKind | null {
  if (!actions.length) return null;
  const kinds: SpotKind[] = ['vertex', 'edge', 'hex'];
  const rest = (a: Action, k: SpotKind) => JSON.stringify(Object.entries(a).filter(([f]) => f !== k).sort(([x], [y]) => (x < y ? -1 : 1)));
  return (
    kinds.find((k) => {
      if (!actions.every((a) => spotOf(a, k) >= 0 && kinds.every((o) => o === k || spotOf(a, o) < 0))) return false;
      const first = rest(actions[0], k);
      return actions.every((a) => rest(a, k) === first);
    }) ?? null
  );
}

/** Light up spots on the board for a moment (a proposal hovered), or put back the pick's own. */
export function previewSpots(kind: SpotKind | null, ids: number[] = []) {
  if (kind) session.view?.showMarkers(kind, ids);
  else session.presenter?.syncMarkers();
}

/** A seat's colour for the interface. */
export const seatColor = (s: GameState, p: PlayerId) => PLAYER_PALETTE[s.players[p].color].ui;

/** "You" or a player's name. */
export const nameOf = (s: GameState, p: PlayerId, me: PlayerId) => (p === me ? 'You' : s.players[p].name);

/** A player's mark and name, in their colour (the mark carries who it is without colour). */
export function Seat({ s, p, me, short = false }: { s: GameState; p: PlayerId; me: PlayerId; short?: boolean }) {
  const name = nameOf(s, p, me);
  return (
    <span className="mp-seat" style={{ ['--pc' as string]: seatColor(s, p) }}>
      <SeatMark seat={p} color={seatColor(s, p)} size={10} />
      <span className="mp-seat-name">{short && p !== me ? name.split(' ').slice(-1)[0] : name}</span>
    </span>
  );
}

/** Pips out of a most: `n` filled of `max` (oil held, levels climbed), read out as words. */
export function Pips({ n, max, label, tone }: { n: number; max: number; label: string; tone?: string }) {
  return (
    <span className="mp-pips" role="img" aria-label={label} style={tone ? { ['--tone' as string]: tone } : undefined}>
      {Array.from({ length: max }, (_, i) => (
        <i key={i} className={i < n ? 'on' : undefined} />
      ))}
    </span>
  );
}
