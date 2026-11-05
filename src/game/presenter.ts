// Turns host messages into a choreographed presentation: 3D animations, card
// flights between the board and the HUD, banners, log lines and sound, then
// hands control to the human or the next bot. Online (a remote host) the room
// moves the bots and the others are people too: the events come with their
// secrets left out (a card face down), and a presentation that falls behind
// the room hurries to catch up.

import {
  CARDS,
  COSTS,
  RESOURCES,
  TERRAIN_RESOURCE,
  devCardsInGame,
  playableDevCards,
  legalActions,
  legalCities,
  legalRoads,
  legalRobberHexes,
  legalSettlements,
  legalSetupRoads,
  legalSetupSettlements,
  hexGrants,
  longestRoadEdges,
  numbersOf,
  trackedKinds,
  isOpenOffer,
  type DevCardType,
  type GameEvent,
  type GameState,
  type StealCause,
  type PlayerId,
  type Card,
  type CardCounts,
} from '../engine';
import type { World } from '../render/World';
import type { BoardView } from '../render/board/boardView';
import type { MarksMode } from '../render/board/marks';
import { fogWithinReach } from '../render/board/fogBoard';
import { reducedMotion } from '../app/display';
import { THROW_TIME } from '../render/fx/dice3d';
import type { GameHost, HostMessage } from './host';
import { BOT_PACE, MAIN_HINT, animSpeed, animatorSpeed, emptyCounts, interactionSpots, showError, useUI, type Flight, type Interaction, type UIStore } from './store';
import { decisionFor, moduleActions, refreshedPick, spotOf, stagedStep } from './moduleActions';
import { decisionText } from './decisions';
import { handPick } from './handPicks';
import { autoAnswer } from './pacing';
import { presentedRoll } from './dice';
import { blockerOf } from './theft';
import { seenHex } from './hexView';
import { sfx, type SfxName } from '../audio/sfx';
import type { Ground } from '../audio/sounds';
import { DEV_NAMES, CARD_NAMES, TOKEN_ICON } from './names';
import { TableTalk } from './chat';
import { islandName, tell, type TableEvent } from './moduleEvents';
import { blockersHeld, sevenBlockers } from './tableWords';

const ui = () => useUI.getState();

type MapPieces = NonNullable<UIStore['mapPieces']>;

/** Thrown out of a presentation when its game was quit mid-animation. */
const DISPOSED = new Error('presenter disposed');

export class Presenter {
  private queue: HostMessage[] = [];
  private running = false;
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Timers for things still to happen in a presentation (sounds, puffs): cleared on quit. */
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Why play is held (a quality change being prepared, the tab hidden): no bot moves meanwhile. */
  // (A game started in a background tab waits for it to be shown, as one hidden mid-game does.)
  private holds = new Set<string>(typeof document !== 'undefined' && document.hidden ? ['hidden'] : []);
  /** Bot moves rejected in a row (each retried with a fresh decision before giving up). */
  private botFailures = 0;
  private unsub: () => void;
  private unsubModal: () => void;

  /** The bots' chat (a local game's: online, the room's bots talk on the server and their lines come as chat). */
  talk: TableTalk | null;

  constructor(
    private host: GameHost,
    private world: World,
    private view: BoardView,
    public me: PlayerId,
  ) {
    this.talk = host.remote ? null : new TableTalk(me, () => this.host.state, (p) => this.host.difficultyOf(p));
    this.unsub = host.subscribe((m) => {
      this.queue.push(m);
      void this.pump();
    });
    // A move the room refused after it went out is told as one refused here would be.
    if (host.remote) host.onError = (error) => !this.disposed && this.refused(error);
    // A mandatory dialog (discard, steal, game over) can be covered by rules or settings; it
    // returns when they close.
    this.unsubModal = useUI.subscribe((st, prev) => {
      if (this.disposed || this.running || st.modal !== null || prev.modal === null) return;
      const s = this.host.state;
      const need =
        s.phase === 'gameOver' ? 'gameover'
        : s.phase === 'steal' && s.currentPlayer === this.me && !this.spectating ? 'steal'
        : s.phase === 'discard' && s.pendingDiscards[this.me] !== undefined && !this.spectating ? 'discard'
        // (A hand pick's dialog that hasn't been seen yet: one closed on purpose stays closed.)
        : !this.cardsShown && !st.batch.length && !this.spectating && handPick(s, this.me) ? 'cards'
        : null;
      if (need === 'cards') this.cardsShown = true;
      if (need && prev.modal !== need) st.set({ modal: need });
    });
  }

  /**
   * In spectator mode (?watch) seat 0 is a bot, in a replay nobody acts, and watching online you
   * have no seat: nothing prompts or acts for it.
   */
  get spectating() {
    return this.host.isBot(this.me) || this.host.scripted || !!this.host.spectator;
  }

  /** Carry on a replay that was paused. */
  nudge() {
    if (!this.running) this.scheduleBots();
  }

  /** Hold play for a reason (or release it); bots wait until nothing holds it. */
  hold(reason: string, on: boolean) {
    if (on) this.holds.add(reason);
    else if (this.holds.delete(reason) && this.holds.size === 0) this.nudge();
  }

  /** setTimeout that a quit cancels. */
  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(t);
  }

  /** Whether you countered the open offer (to report it if it is withdrawn). */
  private myCounter = false;
  /** Whether you accepted the open offer (to report it if it is withdrawn instead). */
  private myAnswer = false;

  private isMe(p: PlayerId) {
    return p === this.me && !this.spectating;
  }

  /**
   * Show the board empty-handed before the intro, so starting resources visibly fly in from
   * the supply (the supply shows them back until each card leaves it).
   */
  prepareIntro() {
    const handDelta: Record<number, CardCounts> = {};
    const bank = emptyCounts();
    for (const p of this.host.state.players) {
      handDelta[p.id] = neg(p.hand);
      for (const r of RESOURCES) bank[r] += p.hand[r];
    }
    handDelta[-1] = bank;
    // (The flat map too starts bare: a beginner set-up's pieces are placed as the intro presents them.)
    const s = this.host.state;
    ui().set({ view: s, handDelta, busy: true, mapPieces: { buildings: s.buildings.map(() => null), routes: s.routes.map(() => null), robberHex: s.robberHex } });
  }

  /** Present the events produced by game creation (beginner pre-placement, first player). */
  async intro(events: GameEvent[]) {
    this.running = true;
    try {
      await this.presentEvents(events, this.host.state);
    } catch (e) {
      if (e !== DISPOSED) console.error('presentation error', e);
    } finally {
      this.running = false;
    }
    if (this.disposed) return;
    this.settle(this.host.state);
    this.host.presented?.();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    ui().set({ busy: true });
    try {
      while (this.queue.length && !this.disposed) {
        const m = this.queue.shift()!;
        this.catchUp();
        try {
          if (m.jump) await this.jumpTo(m.state);
          else await this.presentEvents(m.events, m.state);
        } catch (e) {
          if (e !== DISPOSED) console.error('presentation error', e);
        }
        if (this.disposed) break;
        this.commit(m.state);
        // (The room hears it, and holds its next bot move for it: see RemoteHost.presented.)
        if (m.seq !== undefined) this.host.presented?.(m.seq);
      }
    } finally {
      this.running = false;
    }
    if (this.disposed) return;
    this.catchUp(false);
    this.settle();
  }

  /**
   * Online, a presentation that has fallen behind the room (a phone back from sleep, a slow
   * device at a quick table) plays faster until it has caught up, as if hurried.
   */
  private catchUp(on = !!this.host.catchUp) {
    if (ui().catchUp === on) return;
    ui().set({ catchUp: on });
    this.world.animator.speed = animatorSpeed();
  }

  /**
   * The view jumped (online, a resync from too far behind for the records): the pieces on the
   * island are set to it as they stand, without their animations, and the hexes found meanwhile
   * come up out of the fog at once.
   */
  private async jumpTo(next: GameState) {
    const before = ui().view ?? this.host.state;
    for (let v = 0; v < next.buildings.length; v++) {
      const a = before.buildings[v];
      const b = next.buildings[v];
      if (a?.owner === b?.owner && a?.kind === b?.kind) continue;
      if (b) await this.view.setBuilding(v, b.owner, b.kind, false);
      else await this.view.removeBuilding(v, false);
    }
    for (let e = 0; e < next.routes.length; e++) {
      const a = before.routes[e];
      const b = next.routes[e];
      if (a?.owner === b?.owner && a?.kind === b?.kind) continue;
      // (Ships and bridges are the expansions' marks: the commit after this syncs them.)
      if (b?.kind === 'road') await this.view.setRoad(e, b.owner, false);
      else if (a?.kind === 'road') await this.view.removeRoad(e, false);
    }
    if (next.robberHex !== before.robberHex) {
      if (next.robberHex === null) {
        this.view.robber.visible = false;
        this.view.crows(null);
      } else {
        this.view.placeRobberAt(next.robberHex);
        this.view.robber.visible = true;
        this.view.crows(next.robberHex);
      }
    }
    for (const h of next.board.hexes) {
      if (before.board.hexes[h.id] && before.board.hexes[h.id].terrain !== h.terrain) await this.anim(this.world.fog?.reveal(next, h.id, { instant: true, calm: true }) ?? Promise.resolve());
    }
    this.showRoute(next);
  }

  /**
   * A presentation is over: commit (if it hadn't), apply the actions made while it ran, in order
   * (one that starts a presentation of its own takes over from here), then hand over control.
   */
  private settle(state?: GameState) {
    try {
      if (state) this.commit(state);
      while (this.pending.length) {
        const queued = this.pending.shift()!;
        if (this.act(queued) === null && this.running) return;
      }
      ui().set({ busy: false });
      this.afterIdle();
    } catch (e) {
      // Never leave the game held busy with nobody to move.
      console.error('presentation error', e);
      ui().set({ busy: false });
      showError('Something went wrong; the game carries on.', 6000);
    }
  }

  /** Bumped on every commit; a card that lands after a later commit must not count twice. */
  private commitGen = 0;

  private commit(state: GameState) {
    this.commitGen++;
    // (Landings still batched belong to the state being replaced: it shows them all.)
    this.bumps.clear();
    ui().set({ view: state, handDelta: {}, mapPieces: null });
    void this.view.syncMarks(state, this.flat || reducedMotion() ? 'none' : 'soft');
    this.world.fog?.setReach(fogWithinReach(state, this.spectating ? null : ui().me));
    this.world.setTimeFromTurn(state.turn, state.players.length);
  }

  // ------------------------------------------------------------------ control

  private afterIdle() {
    if (this.disposed) return;
    // (Mid-batch, the decision isn't settled yet: the next move goes before anything is offered.)
    if (ui().batch.length && this.nextInBatch()) return;
    // (A pacing default you've asked for answers for you before the decision is offered at all.)
    if (this.autoAnswer()) return;
    const s = this.host.state;
    this.trackReplay(s);
    this.updateInteraction(s);
    if (s.phase === 'gameOver') return;
    this.scheduleBots();
  }

  /** A replay's progress for its panel; a fast-forward ends once its turn has come. */
  private trackReplay(s: GameState) {
    const p = this.host.scriptProgress;
    const r = ui().replay;
    if (!p || !r) return;
    const ff = r.ff && s.turn < r.until && s.phase !== 'gameOver';
    ui().set({ replay: { ...r, index: p.at, total: p.total, ff } });
    if (ff !== r.ff) this.world.animator.speed = animatorSpeed();
  }

  private scheduleBots() {
    if (this.botTimer) clearTimeout(this.botTimer);
    if (this.holds.size) return;
    let next: ReturnType<GameHost['nextBotAction']>;
    try {
      next = this.host.nextBotAction();
    } catch (e) {
      this.botFailed(e);
      return;
    }
    if (!next) return;
    // botDecide updates the bot's memory, so execute this decision rather than deciding twice.
    const seq = this.host.state.seq;
    const speed = animSpeed();
    const isCurrent = next.player === this.host.state.currentPlayer;
    const base = this.host.scripted ? 380 : next.action.type === 'respondTrade' ? 900 : next.action.type === 'discard' ? 700 : isCurrent ? 650 : 500;
    // (The table's pace setting; a replay keeps its own.)
    const pace = this.host.scripted ? 1 : BOT_PACE[useUI.getState().settings.botPace];
    // (The opening placements at half the pause: the player waits through every bot's before
    // their own first move, and a bot's opening needs no build-up.)
    const opening = !this.host.scripted && this.host.state.phase.startsWith('setup') ? 0.5 : 1;
    const think = ((base + Math.random() * 450) * pace * opening) / Math.max(0.25, speed);
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      // (A replay paused while this move waited keeps it for later.)
      if (this.disposed || this.running || this.host.paused || this.holds.size) return;
      try {
        // Re-evaluate only if the state changed while we waited.
        const again = this.host.state.seq === seq ? next : this.host.nextBotAction();
        if (!again) return;
        const r = this.host.submitBot(again);
        if (r.ok) this.botFailures = 0;
        else this.botFailed(new Error(`bot action rejected: ${r.error}`));
      } catch (e) {
        this.botFailed(e);
      }
    }, think);
  }

  /**
   * A bot's move was refused (or deciding it threw): think again from scratch, a few times. A
   * replay the game can no longer follow stops with a word instead of hanging.
   */
  private botFailed(e: unknown) {
    console.warn(e);
    this.botFailures++;
    if (this.host.scripted) {
      ui().pushBanner({ title: 'Replay stopped', subtitle: 'This game was recorded by an older version', tone: 'warn' }, 4000);
      this.log(null, 'The replay can’t continue from here');
      return;
    }
    if (this.botFailures <= 3) this.later(() => this.scheduleBots(), 250);
    else {
      // (Until something replaces it: it says what to do.)
      showError(`${this.name(this.host.state.currentPlayer)} is stuck; try Undo or start a new game`, 0);
      this.botFailures = 0;
    }
  }

  /** Human actions made while something was animating; applied in order as soon as it finishes. */
  private pending: Parameters<GameHost['submit']>[1][] = [];

  /** Submit an action for the local human. Returns an error message for the UI. */
  act(action: Parameters<GameHost['submit']>[1]): string | null {
    if (this.spectating) return 'You are spectating.';
    // Don't drop the input (e.g. a discard while another player's cards are still flying): queue
    // it and apply it when the presentation settles. Online it goes at once, checked against the
    // room's newest view, and the room refuses it if what it answered has moved on meanwhile.
    if (this.running && !this.host.remote) {
      this.pending.push(action);
      return null;
    }
    const r = this.host.submit(this.me, action);
    if (!r.ok) {
      this.refused(r.error);
      return r.error;
    }
    return null;
  }

  /**
   * Make moves chosen together that the engine takes one at a time (the cards of a hand pick): the
   * first now, each of the rest once the one before has landed (`nextInBatch`), so a room online,
   * which takes one move at a time from a seat, gets them in turn too. The error is the first's.
   */
  actAll(actions: Parameters<GameHost['submit']>[1][]): string | null {
    if (!actions.length) return null;
    ui().set({ batch: actions });
    const err = this.act(actions[0]);
    if (err) ui().set({ batch: [] });
    return err;
  }

  /**
   * A batch's move has landed (the batch's first): the next is made, and true, unless none is left
   * to make. The batch is dropped once its next move isn't legal (the decision it answered has
   * gone) or is refused, here or by the room.
   */
  private nextInBatch(): boolean {
    const [, next, ...rest] = ui().batch;
    if (!next) {
      ui().set({ batch: [] });
      return false;
    }
    ui().set({ batch: [next, ...rest] });
    const key = JSON.stringify(next);
    if (!legalActions(this.host.state, this.me).some((a) => JSON.stringify(a) === key) || this.act(next) !== null) {
      ui().set({ batch: [] });
      return false;
    }
    return true;
  }

  /** The state and move last answered for you, so a refused one isn't tried again on the same state. */
  private autoKey = '';

  /**
   * Answer the decision you owe now for you, when a pacing default you've turned on applies
   * (game/pacing.ts): a wagon auction passed, a pick taken in your resource. The table says so.
   */
  private autoAnswer(): boolean {
    if (this.spectating) return false;
    const s = this.host.state;
    const auto = autoAnswer(s, this.me, ui().settings);
    if (!auto) return false;
    const key = `${s.seq}:${JSON.stringify(auto.action)}`;
    if (key === this.autoKey) return false;
    this.autoKey = key;
    if (this.act(auto.action) !== null) return false;
    this.log(this.me, auto.why);
    return true;
  }

  /** A hand pick's dialog has opened for the decision owed now (it opens once, as a discard's does). */
  private cardsShown = false;

  /** A move refused: its sound, and the reason for a moment. */
  private refused(error: string) {
    // (What was left of a batch answered the decision as it stood before this.)
    if (ui().batch.length) ui().set({ batch: [] });
    sfx.play('error');
    showError(error);
  }

  updateInteraction(s: GameState) {
    const me = this.me;
    const store = ui();
    if (this.spectating) {
      // (Online, from the quay or a seat given up, it's "Watching", as the room's link says.)
      store.set({ interaction: { kind: 'idle' }, hint: s.phase === 'gameOver' ? '' : `${this.host.scripted ? `Replay · turn ${Math.max(1, s.turn)}` : this.host.remote ? 'Watching' : 'Spectating'} · ${s.players[s.currentPlayer].name}'s turn` });
      if (s.phase === 'gameOver') store.set({ modal: 'gameover' });
      return;
    }
    const mine = s.currentPlayer === me;
    let hint = '';
    let interaction = store.interaction;
    let modal = store.modal;
    if (modal === 'discard' || modal === 'steal') modal = null;
    // A hand pick opens its dialog when it falls to you, once: closed, the dock's card opens it again.
    const cards = handPick(s, me);
    if (!cards) {
      this.cardsShown = false;
      if (modal === 'cards') modal = null;
    } else if (!this.cardsShown && modal === null && !store.batch.length) {
      modal = 'cards';
      this.cardsShown = true;
    }
    // An expansion's pick on the board carries on with its moves worked out afresh, and ends when none is left.
    const pick = this.refreshPick(s, interaction);
    const owed = decisionFor(s, me);
    const top = s.pending[s.pending.length - 1];
    if (owed) {
      // A decision an expansion has left you owing comes before anything else (ModuleControls offers its answers).
      interaction = pick;
      hint = decisionText(s, me, owed);
    } else if (top) {
      interaction = { kind: 'idle' };
      hint = `Waiting for ${top.players.map((p) => s.players[p].name).join(', ')} to decide…`;
    } else if (s.phase === 'endOfTurn') {
      interaction = { kind: 'idle' };
      hint = 'The turn is ending…';
    } else if (s.phase === 'setupSettlement' && mine) {
      interaction = { kind: 'setupSettlement', spots: legalSetupSettlements(s) };
      hint = s.setupRound === 1 ? 'Place your first house' : 'Place your second house — it collects starting resources';
    } else if (s.phase === 'setupRoad' && mine) {
      interaction = { kind: 'setupRoad', spots: legalSetupRoads(s) };
      hint = 'Place a road next to your new house';
    } else if (s.phase === 'moveRobber' && mine) {
      interaction = { kind: 'robber', hexes: legalRobberHexes(s) };
      hint = 'Move the robber to any other hex';
    } else if (s.phase === 'roadBuilding' && mine) {
      interaction = { kind: 'road', spots: legalRoads(s, me), free: true };
      hint = `Road Crew: place ${s.freeRoadsLeft} free road${s.freeRoadsLeft === 1 ? '' : 's'}`;
    } else if (s.phase === 'steal' && mine) {
      interaction = { kind: 'idle' };
      modal = 'steal';
      hint = 'Choose a player to rob';
    } else if (s.phase === 'discard' && s.pendingDiscards[me] !== undefined) {
      interaction = { kind: 'idle' };
      modal = 'discard';
      hint = `Discard ${s.pendingDiscards[me]} cards`;
    } else if (s.phase === 'discard') {
      interaction = { kind: 'idle' };
      // (Online the others are people, each on their own device: say whom the table waits on.)
      hint = this.host.remote ? `Waiting for ${this.names(Object.keys(s.pendingDiscards).map(Number))} to discard…` : 'Waiting for players to discard…';
    } else if (s.phase === 'roll' && mine) {
      interaction = pick;
      // (Only with a card you could play now: not where the expansions have taken them away, nor with none in hand.)
      hint = devCardsInGame(s) && playableDevCards(s, me).length > 0 ? 'Roll the dice (or play a development card first)' : 'Roll the dice';
    } else if (s.phase === 'main' && mine) {
      // A build mode carries on with its spots worked out afresh (a trade may have changed what's
      // affordable, a road what's reachable); one with nothing left to place ends.
      if (interaction.kind === 'road' || interaction.kind === 'settlement' || interaction.kind === 'city') {
        const spots = interaction.kind === 'road' ? legalRoads(s, me) : interaction.kind === 'settlement' ? legalSettlements(s, me) : legalCities(s, me);
        const cost = COSTS[interaction.kind];
        const afford = RESOURCES.every((r) => s.players[me].hand[r] >= cost[r]);
        interaction = spots.length && afford ? { kind: interaction.kind, spots } : { kind: 'idle' };
      } else interaction = pick;
      // (Rolled, the turn is the player's to play: the line says what is open to them, rather than
      // going blank. While placing, the dock or the actions say what to tap instead. Your own offer,
      // online: who is still to answer it.)
      const waiting = this.host.remote && s.trade?.proposer === me ? this.unanswered(s) : [];
      hint = waiting.length ? `Waiting for ${this.names(waiting)} to answer` : interaction.kind === 'idle' ? MAIN_HINT : '';
    } else if (s.phase === 'gameOver') {
      interaction = { kind: 'idle' };
      modal = 'gameover';
    } else {
      interaction = { kind: 'idle' };
      const t = s.trade;
      const asked = !!t && t.proposer !== me && (t.to.length === 0 || t.to.includes(me)) && t.responses[me] === undefined && t.counters[me] === undefined;
      // Online, an offer between others waits on people too: who is still to answer it.
      const waiting = this.host.remote && t && !asked ? this.unanswered(s) : [];
      hint = asked ? `${s.players[s.currentPlayer].name} is waiting for your answer` : waiting.length ? `Waiting for ${this.names(waiting)} to answer` : `${s.players[s.currentPlayer].name} is thinking…`;
    }
    // An unrelated host message must not take a legal choice away under the player's hand.
    // Intersect exact actions: newly legal alternatives belong to a freshly opened list.
    const now = store.choice ? new Set(legalActions(s, me).map((a) => JSON.stringify(a))) : null;
    const choices = store.choice?.actions.filter((a) => now!.has(JSON.stringify(a))) ?? [];
    const choice = choices.length && s.phase !== 'gameOver' ? { ...store.choice!, actions: choices } : null;
    store.set({ interaction, hint, modal, choice });
    this.syncMarkers();
  }

  /** The players the open offer is made to who haven't answered it (you aside). */
  private unanswered(s: GameState): PlayerId[] {
    const t = s.trade;
    if (!t) return [];
    return s.players.map((p) => p.id).filter((p) => p !== t.proposer && p !== this.me && (t.to.length === 0 || t.to.includes(p)) && t.responses[p] === undefined && t.counters[p] === undefined);
  }

  /** Players named in a sentence: "Ana", "Ana and Ben", "Ana, Ben and Cy". */
  private names(ps: PlayerId[]) {
    const n = ps.map((p) => this.host.state.players[p]?.name ?? '');
    return n.length <= 1 ? (n[0] ?? 'the others') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  }

  /** An expansion's pick on the board with its moves as they stand in `s` (idle once there are none). */
  private refreshPick(s: GameState, it: Interaction): Interaction {
    if (it.kind !== 'pick') return { kind: 'idle' };
    if (it.chosen) {
      // A staged pick keeps what's chosen while it still fits, and starts again when it doesn't.
      // (Its moves as refreshed by their kind and spot: a resurvey's are one venture's plays among all.)
      const actions = refreshedPick(it.actions, moduleActions(s, this.me), it.target);
      const step = stagedStep(actions, it.chosen) ?? stagedStep(actions, [[]]);
      return step && !step.done ? { ...it, actions, spots: step.spots, chosen: step.chosen } : { kind: 'idle' };
    }
    const actions = refreshedPick(it.actions, moduleActions(s, this.me), it.target, it.source);
    const spots = [...new Set(actions.map((a) => spotOf(a, it.target, s, it.source)).filter((v) => v >= 0))];
    return spots.length ? { ...it, actions, spots } : { kind: 'idle' };
  }

  syncMarkers() {
    const it = ui().interaction;
    const sp = interactionSpots(it);
    // (A hex is outlined for an expansion's pick; the robber's targets, nearly every hex, keep to the input layer's hover glow.)
    if (sp && (sp.kind !== 'hex' || it.kind === 'pick')) this.view.showMarkers(sp.kind, sp.ids);
    else this.view.showMarkers(null);
  }

  // ------------------------------------------------------------- presenting

  private async presentEvents(events: GameEvent[], next: GameState) {
    for (let i = 0; i < events.length; i++) {
      if (this.disposed) return;
      await this.presentEvent(events[i], next, events, i);
    }
  }

  private name(p: PlayerId) {
    return this.isMe(p) ? 'You' : this.host.state.players[p].name;
  }

  /** Name as the object of a sentence ("stole from you"). */
  private obj(p: PlayerId) {
    return this.isMe(p) ? 'you' : this.host.state.players[p].name;
  }

  /** Subject plus verb in the right person: "You decline" / "Wren declines". */
  private says(p: PlayerId, you: string, they: string) {
    return this.isMe(p) ? `You ${you}` : `${this.host.state.players[p].name} ${they}`;
  }

  private log(player: PlayerId | null, text: string) {
    ui().pushLog({ player, text });
  }

  /** Waits that end in a disposed presenter throw, so a quit game stops writing to the HUD. */
  private async wait(s: number) {
    await this.world.animator.wait(s);
    if (this.disposed) throw DISPOSED;
  }

  private async anim<T>(p: Promise<T>): Promise<T> {
    const v = await p;
    if (this.disposed) throw DISPOSED;
    return v;
  }

  /** The holder and edges the pennants stand along now. */
  private route = '';

  /**
   * Put the pennants along the Longest Route as it stands in `s`. `sameHolder`: only follow the
   * route as it grows or is cut (a change of holder raises them with its own announcement).
   */
  showRoute(s: GameState, sameHolder = false) {
    const h = s.longestRoadHolder;
    if (sameHolder && !this.route.startsWith(`${h}:`)) return;
    const edges = h === null ? [] : longestRoadEdges(s, h);
    const key = `${h}:${[...edges].sort((a, b) => a - b).join(',')}`;
    if (key === this.route) return;
    this.route = key;
    this.view.setLongestRoute(h, edges);
  }

  /** On the flat map the island isn't drawn: its pieces go down without their 3D animations. */
  private get flat() {
    return ui().viewMode === '2d';
  }

  /** A change of pieces shown on the flat map at once, ahead of the committed view. */
  private onMap(change: (m: MapPieces) => void) {
    const s = ui();
    const base = s.mapPieces ?? s.view;
    if (!base) return;
    const m = { buildings: [...base.buildings], routes: [...base.routes], robberHex: base.robberHex };
    change(m);
    s.set({ mapPieces: m });
  }

  /**
   * A piece placed: paid for (its cards to the supply), then dropped onto the island with its
   * sound and shown on the flat map in the same moment. In 2D it lands as soon as it's placed,
   * while the payment flies.
   */
  private async place(player: PlayerId, cost: CardCounts | null, sound: SfxName, map: (m: MapPieces) => void, set3d: (animate: boolean) => Promise<void>, at?: { x: number; z: number }, on?: { ground: Ground; wet: boolean }) {
    const flat = this.flat;
    const pay = cost ? this.payCost(player, cost) : null;
    pay?.catch(() => {});
    if (pay && !flat) await pay;
    sfx.play(sound, { at, ...on });
    this.onMap(map);
    await this.anim(set3d(!flat));
    if (flat) await this.wait(0.3);
    if (pay) await pay;
  }

  private async presentEvent(e: GameEvent, next: GameState, events: readonly GameEvent[], at: number) {
    const store = ui();
    this.talk?.onEvent(e);
    // An expansion's build pays its own price just before it (a venture's cheaper city): those cards have flown already.
    const prev = events[at - 1];
    const paid = (p: PlayerId) => prev?.type === 'cardsMoved' && prev.from === p && prev.to === null;
    switch (e.type) {
      case 'firstPlayerChosen': {
        const p = e.player;
        store.pushBanner({ title: this.isMe(p) ? 'You go first!' : `${this.name(p)} goes first`, subtitle: 'Highest roll starts the game', tone: 'player', player: p }, 2400);
        this.log(p, `${this.name(p)} won the starting roll`);
        await this.wait(1.1);
        return;
      }
      case 'setupSettlementPlaced':
      case 'settlementBuilt': {
        await this.place(e.player, e.type === 'settlementBuilt' && !paid(e.player) ? COSTS.settlement : null, 'build', (m) => (m.buildings[e.vertex] = { owner: e.player, kind: 'settlement' }), (animate) => this.view.setBuilding(e.vertex, e.player, 'settlement', animate), next.board.vertices[e.vertex], groundAt(next, next.board.vertices[e.vertex].hexes));
        // (A settlement can cut someone's route.)
        this.showRoute(next, true);
        this.log(e.player, `${this.name(e.player)} built a house`);
        return;
      }
      case 'setupRoadPlaced':
      case 'roadBuilt': {
        await this.place(e.player, e.type === 'roadBuilt' && !e.free && !paid(e.player) ? COSTS.road : null, 'road', (m) => (m.routes[e.edge] = { owner: e.player, kind: 'road', builtTurn: next.turn }), (animate) => this.view.setRoad(e.edge, e.player, animate), edgeAt(next, e.edge), groundAt(next, edgeHexes(next, e.edge), 2));
        this.showRoute(next, true);
        this.log(e.player, `${this.name(e.player)} built a road${e.type === 'roadBuilt' && e.free ? ' (free)' : ''}`);
        return;
      }
      case 'cityBuilt': {
        await this.place(e.player, paid(e.player) ? null : COSTS.city, 'city', (m) => (m.buildings[e.vertex] = { owner: e.player, kind: 'city' }), (animate) => this.view.setBuilding(e.vertex, e.player, 'city', animate), next.board.vertices[e.vertex], groundAt(next, next.board.vertices[e.vertex].hexes));
        this.log(e.player, `${this.name(e.player)} upgraded to a town`);
        return;
      }
      case 'undone': {
        sfx.play('whoosh');
        const animate = !this.flat;
        this.onMap((m) => {
          if (e.kind === 'road') m.routes[e.at] = null;
          else m.buildings[e.at] = e.kind === 'city' ? { owner: e.player, kind: 'settlement' } : null;
        });
        if (e.kind === 'road') await this.anim(this.view.removeRoad(e.at, animate));
        else if (e.kind === 'city') await this.anim(this.view.setBuilding(e.at, e.player, 'settlement', animate));
        else await this.anim(this.view.removeBuilding(e.at, animate));
        this.showRoute(next, true);
        if (CARDS.some((r) => e.refund[r] > 0)) await this.flyCards('bank', e.player, e.refund, {});
        if (CARDS.some((r) => e.returned[r] > 0)) await this.flyCards(e.player, 'bank', e.returned, {});
        this.log(e.player, `${this.says(e.player, 'take back', 'takes back')} a ${e.kind === 'settlement' ? 'house' : e.kind === 'city' ? 'town' : e.kind}`);
        this.awardsTakenBack(ui().view, next);
        return;
      }
      case 'startingResources': {
        await this.flyProduction(
          e.grants.map((g) => ({ player: e.player, hex: g.hex, vertex: e.vertex, resource: g.resource, amount: 1 })),
          next,
        );
        return;
      }
      case 'turnStarted': {
        const p = e.player;
        if (this.isMe(p)) {
          sfx.play('yourTurn');
          store.pushBanner({ title: 'Your turn', subtitle: `Turn ${e.turn}`, tone: 'player', player: p }, 1800);
        }
        this.log(p, this.isMe(p) ? '— Your turn —' : `— ${this.name(p)}'s turn —`);
        return;
      }
      case 'diceRolled': {
        // (The flat map throws its own dice, and sounds them as they strike the table.)
        const mapUp = this.flat && store.flatPhase !== null;
        if (!mapUp) sfx.play('dice');
        const id = Date.now();
        // The engine rolls the event die after the number dice, in this same host message.
        // Gather it now so the physical throw and both HUDs reveal one coherent result.
        store.set({ diceRoll: presentedRoll(e, events, id) });
        const owe = next.phase === 'discard' && next.pendingDiscards[this.me] !== undefined && this.isMe(this.me);
        const [landed, after] = rollPauses(e.total === 7, mapUp, owe);
        await this.wait(landed);
        // Every disc showing the rolled number lifts and glows, so the roll reads on the board itself.
        if (e.total !== 7) this.view.pulseNumber(e.total, next);
        this.log(e.player, `${this.name(e.player)} rolled ${e.total}`);
        if (e.total === 7) {
          sfx.play('robberLaugh');
          store.pushBanner({ title: 'Seven!', subtitle: sevenStirs(next), tone: 'warn' }, 2200);
          await this.wait(after);
        }
        return;
      }
      case 'production': {
        for (const h of e.blockedHexes) {
          const r = terrainRes(next, h);
          // (A hex can be blocked by more than the robber: the corsair, conquest, pollution.)
          const by = h === next.robberHex ? 'The robber blocks' : h === next.ext.sea?.corsair ? 'The corsair blocks' : next.ext.invasion?.raiders[h] === 3 ? 'Raiders hold' : 'No';
          this.log(null, `${by} ${r ? token(1, r) : 'production'} on ${seenHex(next, h).numbers.join(' and ')}`);
        }
        for (const r of e.shortages) {
          this.log(null, `Not enough ${token(1, r)} in the supply`);
          store.pushBanner({ title: `Out of ${CARD_NAMES[r]}`, subtitle: 'The supply can’t pay everyone, so nobody gets any', tone: 'warn' }, 2400);
        }
        await this.flyProduction(e.grants, next, e.total, lostCards(next, e));
        return;
      }
      case 'noProduction': {
        store.pushBanner({ title: `${e.total}`, subtitle: 'Nothing produced this time', tone: 'info' }, 1500);
        await this.wait(0.4);
        return;
      }
      case 'discardRequired': {
        // One line each, so the names never run onto a second line.
        for (const [k, n] of Object.entries(e.players)) this.log(Number(k), `${this.name(Number(k))} must discard ${n}`);
        return;
      }
      case 'discarded': {
        // (What's discarded is public: the cards go back to the supply face up.)
        await this.flyCards(e.player, 'bank', e.resources, {});
        this.log(e.player, `${this.name(e.player)} discarded ${countOf(e.resources)} card${countOf(e.resources) === 1 ? '' : 's'}`);
        return;
      }
      case 'robberMoved': {
        const h = next.board.hexes[e.to];
        // A warden's chase is told by its own event, just after (one line and one sound, not two).
        const chased = events[at + 1]?.type === 'garrisons/chased';
        if (!chased) sfx.play('robber', { at: h });
        this.onMap((m) => (m.robberHex = e.to));
        // (Off the board until now, by an expansion's rule: he steps out where he was, or where he goes.)
        if (!this.view.robber.visible) this.showRobber(e.from ?? e.to);
        if (this.flat) {
          // The flat map's robber glides across (the island's catches up unseen).
          void this.view.moveRobber(e.to);
          await this.wait(0.75);
        } else {
          // You chose the hex, so you're already looking at it; for others, glance over (not with motion reduced).
          if (!this.isMe(e.player) && !reducedMotion()) void this.world.rig.focusOn(h.x, h.z, 1.6 / this.speed());
          await this.anim(this.view.moveRobber(e.to));
        }
        const seen = seenHex(next, e.to);
        if (!chased) this.log(e.player, `${this.name(e.player)} moved the robber to ${seen.numbers.length > 0 ? seen.numbers.join(' and ') : `the ${seen.kind}`}`);
        return;
      }
      case 'stolen': {
        sfx.play('steal');
        // (Oil taken by name is taken in the open: the whole table sees the card. Online, a card
        // you weren't party to comes without its kind, and flies face down.)
        const known = e.resource !== undefined;
        const visible = known && (e.thief === this.me || e.victim === this.me || !!e.named);
        // A blocker's theft goes by way of the piece that made it: the robber lifts the card from
        // the victim and hands it over, the corsair does the same from the water. Fish, a happening,
        // a warden's chase, a venture or a 7 with no blocker out take it straight from the hand.
        let via: { x: number; y: number } | undefined;
        const blocker = blockerOf(e, events, at, next);
        if (blocker) {
          const spot = blocker === 'robber' ? this.view.robberSpot(next.robberHex!) : this.view.corsairSpot(next.ext.sea!.corsair!);
          spot.y += 0.24;
          via = this.view.toScreen(spot);
        }
        await this.flyCards(e.victim, e.thief, single(known ? e.resource : HIDDEN_CARD), { faceDown: !visible, via });
        const how = e.by ? STEAL_WORDS[e.by] : '';
        const named = e.named ? ' by name' : '';
        this.log(e.thief, visible ? `${this.name(e.thief)} stole ${token(1, e.resource)} from ${this.obj(e.victim)}${named}${how}` : `${this.name(e.thief)} robbed ${this.obj(e.victim)}${how}`);
        return;
      }
      case 'nothingToSteal': {
        this.log(e.player, 'Nobody to rob there');
        return;
      }
      case 'devCardBought': {
        await this.payCost(e.player, COSTS.devCard);
        sfx.play('card');
        // The n-th Victory Point card shows the n-th building, matching the hand.
        const vps = next.players[e.player].devCards.filter((c) => c.type === 'victoryPoint').length;
        // (Only its buyer sees what it is: online, nobody else is told.)
        await this.flyDev(e.player, this.isMe(e.player) ? (e.card ?? null) : null, Math.max(0, vps - 1));
        this.log(e.player, `${this.name(e.player)} bought a dev card`);
        return;
      }
      case 'devCardPlayed': {
        sfx.play('devPlay');
        store.pushBanner({ title: DEV_NAMES[e.card], subtitle: `${this.name(e.player)} played a development card`, tone: 'player', player: e.player }, 2200);
        await this.showPlayedCard(e.player, e.card);
        this.log(e.player, `${this.name(e.player)} played ${DEV_NAMES[e.card]}`);
        return;
      }
      case 'monopoly': {
        for (const [victim, n] of Object.entries(e.taken)) {
          await this.flyCards(Number(victim), e.player, { ...emptyCounts(), [e.resource]: n }, {});
        }
        const total = Object.values(e.taken).reduce((a, b) => a + b, 0);
        this.log(e.player, `${this.name(e.player)} took ${token(total, e.resource)} with Hoarder`);
        return;
      }
      case 'invention': {
        const rc = emptyCounts();
        for (const r of e.resources) rc[r]++;
        await this.flyCards('bank', e.player, rc, {});
        this.log(e.player, `${this.name(e.player)} invented ${describe(rc)}`);
        return;
      }
      case 'bankTraded': {
        sfx.play('trade');
        // At a harbour's rate, one of the trader's harbour boats puts out to sea and back (not for a
        // rate that came from elsewhere: the Guilds' trader on a hex, or Commerce's commodities).
        const harbour = harbourFor(next, e.player, e.give, e.giveCount / e.getCount);
        if (!this.flat && !e.undo && harbour) this.view.harbourTrade(e.player, harbour);
        await this.flyCards(e.player, 'bank', { ...emptyCounts(), [e.give]: e.giveCount }, {});
        await this.flyCards('bank', e.player, { ...emptyCounts(), [e.get]: e.getCount }, {});
        if (e.undo) this.log(e.player, `${this.says(e.player, 'take back', 'takes back')} a trade`);
        else this.log(e.player, `${this.name(e.player)} traded ${token(e.giveCount, e.give)} for ${token(e.getCount, e.get)}`);
        return;
      }
      case 'tradeOffered': {
        this.myCounter = false;
        this.myAnswer = false;
        sfx.play('offer');
        // (An open offer asks nothing in particular: the others bid.)
        this.log(e.offer.proposer, `${this.says(e.offer.proposer, 'offer', 'offers')} ${describe(e.offer.give)} for ${isOpenOffer(e.offer) ? 'the best bid' : describe(e.offer.get)}`);
        return;
      }
      case 'tradeResponded': {
        if (this.isMe(e.player) && e.accept) this.myAnswer = true;
        this.log(e.player, e.accept ? this.says(e.player, 'accept', 'accepts') : this.says(e.player, 'decline', 'declines'));
        return;
      }
      case 'tradeCountered': {
        if (this.isMe(e.player)) this.myCounter = true;
        this.log(e.player, `${this.says(e.player, 'counter', 'counters')} ${describe(e.give)} for ${describe(e.get)}`);
        return;
      }
      case 'tradeExecuted': {
        this.myCounter = false;
        sfx.play('trade');
        await Promise.all([this.flyCards(e.from, e.to, e.give, {}), this.flyCards(e.to, e.from, e.get, {}, 0.15)]);
        this.log(e.from, `${this.name(e.from)} traded with ${this.obj(e.to)}`);
        return;
      }
      case 'tradeCancelled':
        // Otherwise a turned-down counter just vanishes without a word.
        if (this.isMe(e.player)) this.log(e.player, 'You withdraw your offer');
        else if (this.myCounter) this.log(e.player, `${this.name(e.player)} turns down your counter`);
        else if (this.myAnswer) this.log(e.player, `${this.name(e.player)} withdraws the offer`);
        this.myCounter = false;
        this.myAnswer = false;
        return;
      case 'longestRoadChanged': {
        this.showRoute(next);
        if (e.to !== null) {
          sfx.play('award');
          store.pushBanner({ title: 'Longest Route', subtitle: `${this.name(e.to)} — ${e.length} roads (+2 VP)`, tone: 'player', player: e.to }, 2600);
          this.log(e.to, `${this.says(e.to, 'have', 'has')} the Longest Route`);
          await this.flyBonus('longestRoute', e.from, e.to);
        } else {
          this.log(null, 'Nobody holds the Longest Route now');
        }
        await this.wait(0.5);
        return;
      }
      case 'largestArmyChanged': {
        if (e.to !== null) {
          sfx.play('award');
          store.pushBanner({ title: 'Biggest Army', subtitle: `${this.name(e.to)} — ${e.knights} knights (+2 VP)`, tone: 'player', player: e.to }, 2600);
          this.log(e.to, `${this.says(e.to, 'have', 'has')} the Biggest Army`);
          await this.flyBonus('largestArmy', e.from, e.to);
        }
        await this.wait(0.5);
        return;
      }
      case 'freeRoadsFinished':
      case 'turnEnded':
        return;
      case 'gameWon': {
        sfx.play('victory');
        this.log(e.player, `${this.says(e.player, 'win', 'wins')} with ${e.points} points!`);
        this.world.celebrate();
        await this.wait(1.2);
        return;
      }
      // The expansions' events, and the core events only they raise.
      case 'cardsMoved':
      case 'coins':
      case 'coinTraded':
      case 'gameLost':
      default:
        await this.presentModuleEvent(e, next, events, at);
        return;
    }
  }

  /** Who each expansion award was last announced for. */
  private awards = new Map<string, PlayerId | undefined>();

  /**
   * An expansion's event: its sound and its banner (for a big moment) at once, the glow on the hex
   * it concerns and a glance at it, its cards in flight and its pieces changed on the board, then
   * its log line and a beat to take a big moment in. What each event says is in moduleEvents.ts.
   */
  private async presentModuleEvent(e: TableEvent, next: GameState, events: readonly GameEvent[], at: number) {
    const told = tell(e, { s: next, events, at, isMe: (p) => this.isMe(p) });
    // (An award back with the holder it last went to, after a tie sent it to the supply, isn't news.)
    const again = told.award && told.banner && this.awards.get(told.award) === told.banner.player;
    if (told.award && told.banner) this.awards.set(told.award, told.banner.player);
    if (told.sound) sfx.play(again ? 'trade' : told.sound.name, { at: told.sound.at, volume: again ? 0.5 : told.sound.volume, rate: again ? undefined : told.sound.rate });
    if (told.banner && !again) {
      const { ms, ...banner } = told.banner;
      ui().pushBanner(banner, ms);
    }
    if (!this.flat) {
      // (A hex found in the fog glows, and pays, once it has risen: see its stage.)
      if (e.type !== 'sea/hexRevealed') for (const h of told.glow ?? []) this.world.produce(h);
      // (No camera glance with motion reduced: the banner and the hex's glow say where.)
      if (told.look !== undefined && !reducedMotion()) {
        const h = next.board.hexes[told.look];
        void this.world.rig.focusOn(h.x, h.z, 1.6 / this.speed());
      }
    }
    await this.stageModuleEvent(e, next, events, at);
    for (const l of told.lines) this.log(l.player, l.text);
    if (told.hold) await this.wait(told.hold);
  }

  /**
   * Taking back a build takes back whatever it won (the Port Captain award, the Richest tile, the
   * Steward, a first landing): the engine restores the earlier game without an event for each, so
   * say what went back, and remember the awards' holders as they now are, or the next real win
   * would pass as "no news".
   */
  private awardsTakenBack(before: GameState | null, next: GameState) {
    for (const l of awardsUndone(before, next, (p) => this.isMe(p))) this.log(l.player, l.text);
    const holders: [string, PlayerId | null | undefined][] = [
      ['harbourmaster', next.ext.harbourmaster?.holder],
      ['richest', next.ext.rivers?.richest],
      ['steward', next.ext.oil?.steward],
    ];
    for (const [award, holder] of holders) if (holder !== undefined) this.awards.set(award, holder ?? undefined);
  }

  /** What an expansion's event moves: cards between the hands and the supply, and the pieces it changes on the island. */
  private async stageModuleEvent(e: TableEvent, next: GameState, events: readonly GameEvent[], at: number) {
    const animate = !this.flat;
    /** The pieces as of this event (not the message's end: three landings land one by one). */
    const asOf = () => stagedState(next, events, at);
    switch (e.type) {
      case 'cardsMoved':
        // (A card found in the fog comes up out of its hex once the land has risen: see 'sea/hexRevealed'.)
        if (e.reason === 'found') return;
        // In the open: costs fly to the supply, picks out of it, gifts from hand to hand.
        await this.flyCards(e.from ?? 'bank', e.to ?? 'bank', e.cards, {});
        return;
      case 'coinTraded': {
        const rc = { ...emptyCounts(), [e.card]: e.cards };
        if (e.bought) await this.flyCards('bank', e.player, rc, {});
        else await this.flyCards(e.player, 'bank', rc, {});
        return;
      }
      case 'oil/produced':
        await this.flyProduction(e.grants, next, undefined, [], false);
        return;
      case 'oil/startingOil': {
        // Out of the wells beside the new building.
        const wells = next.board.vertices[e.vertex].hexes.filter((h) => next.board.hexes[h].well);
        if (!wells.length) {
          await this.flyCards('bank', e.player, { ...emptyCounts(), oil: e.amount }, {});
          return;
        }
        const n = Math.min(wells.length, e.amount);
        const grants = wells.slice(0, n).map((hex, i) => ({ player: e.player, hex, vertex: e.vertex, resource: 'oil' as const, amount: i === 0 ? e.amount - n + 1 : 1 }));
        await this.flyProduction(grants, next, undefined, [], false);
        return;
      }
      case 'oil/wellPolluted': {
        // A gout of black smoke off the well (see render/board/pollution.ts).
        this.world.disasters?.wellStruck(e.hex, { instant: !animate, calm: reducedMotion() });
        // Oil leaving the game greys and crumbles where it was held.
        const gone: Promise<void>[] = [];
        if (e.fromSupply > 0) gone.push(this.loseCards('bank', { ...emptyCounts(), oil: e.fromSupply }));
        for (const [p, n] of Object.entries(e.fromHands)) gone.push(this.loseCards(Number(p), { ...emptyCounts(), oil: n }));
        await Promise.all(gone);
        return;
      }
      case 'oil/sequestered':
        await this.loseCards(e.player, { ...emptyCounts(), oil: 1 });
        return;
      case 'fleet/token':
        // The defence token lifts off the defender's banner and goes to them.
        await this.flyToken(TOKEN_ICON.defence, e.player);
        return;
      case 'fisheries/drew': {
        // A fish token comes up out of the supply to its catcher, face down (its value is theirs to know).
        const sp = this.speed();
        ui().addFlights([{ kind: 'token', art: TOKEN_ICON.fish, from: this.anchorPoint('bank'), to: this.tokenRow(e.player), delay: 0, duration: 0.75 / sp, rotate: 8, scale: this.isMe(e.player) ? 0.6 : 0.45, endScale: 0.28, onLand: () => sfx.play('cardLand') }]);
        await this.wait(0.3);
        return;
      }
      case 'fisheries/card': {
        sfx.play('card');
        const vps = next.players[e.player].devCards.filter((c) => c.type === 'victoryPoint').length;
        await this.flyDev(e.player, this.isMe(e.player) ? (e.card ?? null) : null, Math.max(0, vps - 1));
        return;
      }
      case 'rivers/bridgeBuilt':
        // A stone bridge rises over the river (its cost has flown).
        await this.place(e.player, null, 'stone', (m) => (m.routes[e.edge] = { owner: e.player, kind: 'bridge', builtTurn: next.turn }), (a) => this.view.syncMarks(next, a ? this.marksMode() : 'none'), edgeAt(next, e.edge), groundAt(next, edgeHexes(next, e.edge), 2));
        this.showRoute(next, true);
        return;
      case 'sea/shipBuilt':
        // Launched from the coast (the flat map has it at once).
        this.onMap((m) => (m.routes[e.edge] = { owner: e.player, kind: 'ship', builtTurn: next.turn }));
        await this.anim(this.view.syncMarks(asOf(), this.marksMode()));
        return;
      case 'sea/shipMoved':
        this.onMap((m) => {
          m.routes[e.to] = m.routes[e.from] ?? { owner: e.player, kind: 'ship', builtTurn: next.turn };
          m.routes[e.from] = null;
        });
        await this.anim(this.view.syncMarks(asOf(), this.marksMode()));
        return;
      // (The raiders' attack moves nothing itself: the longships are at the island from the last
      // step, and the walls it costs, the wardens it leaves at rest and the longships turning back
      // follow with the sacking, at the message's next staged event or its end.)
      // The expansions' other pieces on the move: the longships, the corsair, wardens, raiders,
      // wagons, and what's raised at the buildings, each shown as it stands after this event.
      case 'fleet/advanced':
      case 'fleet/blockersIn':
      case 'sea/corsairMoved':
      case 'garrisons/recruited':
      case 'garrisons/promoted':
      case 'garrisons/mustered':
      case 'garrisons/wall':
      case 'garrisons/marched':
      case 'garrisons/displaced':
      case 'garrisons/retreated':
      case 'garrisons/removed':
      case 'garrisons/chased':
      case 'garrisons/placed':
      case 'invasion/wardenRaised':
      case 'invasion/marched':
      case 'invasion/displaced':
      case 'invasion/retreated':
      case 'invasion/losses':
      case 'invasion/landed':
      case 'invasion/raidersLed':
      case 'invasion/captured':
      case 'guilds/raiderCaptured':
      case 'guilds/seat':
      case 'guilds/trader':
      case 'caravans/wagonPlaced':
      case 'oil/foundryBuilt':
      // (A quake's crack across a road, and its mending.)
      case 'almanac/cracked':
      case 'almanac/repaired':
        // (The robber the raiders' first attack brings ashore walks on after the corsair has come.)
        await this.anim(this.view.syncMarks(asOf(), this.marksMode()));
        if (e.type === 'fleet/blockersIn' && e.robber !== null) await this.robberTo(e.robber);
        return;
      case 'oil/polluted':
        // The disc cracks and sinks, and the blight spreads over the hex (see render/board/pollution.ts).
        await this.anim(this.world.disasters?.strike(next, e.hex, e.number, { instant: !animate, calm: reducedMotion() }) ?? Promise.resolve());
        return;
      case 'sea/hexRevealed':
        // The fog over it parts, and land comes up out of the sea with its number (see render/board/fog.ts);
        // then it glows as a harvest does, and the finder's card rises out of it.
        await this.anim(this.world.fog?.reveal(next, e.hex, { instant: !animate, calm: reducedMotion() }) ?? Promise.resolve());
        if (e.grant) await this.flyProduction([{ player: e.player, hex: e.hex, resource: e.grant, amount: 1 }], next, undefined, [], false);
        else if (animate && e.terrain !== 'sea') this.world.produce(e.hex);
        return;
      case 'fleet/pillaged':
        this.onMap((m) => (m.buildings[e.vertex] = { owner: e.player, kind: 'settlement' }));
        await this.anim(this.view.setBuilding(e.vertex, e.player, 'settlement', animate));
        return;
      case 'oil/flood': {
        const dropped = e.dropped.map((v) => ({ v, owner: e.owners[v] }));
        this.onMap((m) => {
          for (const v of e.washed) m.buildings[v] = null;
          for (const d of dropped) m.buildings[d.v] = { owner: d.owner, kind: 'settlement' };
        });
        // The sea swells over the coast and sweeps them off (see render/board/flood.ts).
        const shown = this.world.disasters?.flood(this.view, next.board, e, { instant: !animate, calm: reducedMotion() });
        await this.anim<unknown>(shown ?? Promise.all([...e.washed.map((v) => this.view.removeBuilding(v, animate)), ...dropped.map((d) => this.view.setBuilding(d.v, d.owner, 'settlement', animate))]));
        // (A settlement washed away can cut a route.)
        this.showRoute(next, true);
        return;
      }
      case 'guilds/routeRemoved': {
        this.onMap((m) => (m.routes[e.edge] = null));
        if (e.kind !== 'ship') await this.anim(this.view.removeRoad(e.edge, animate));
        else await this.anim(this.view.syncMarks(next, this.marksMode()));
        this.showRoute(next, true);
        return;
      }
      case 'almanac/robberFled':
        if (e.to !== null) await this.robberTo(e.to);
        else this.hideRobber(e.from);
        return;
      case 'fisheries/blockerRemoved':
        if (e.blocker === 'robber') this.hideRobber(e.from);
        return;
      default:
        return;
    }
  }

  /** How the expansions' pieces show a move: staged on the island, at once on the flat map or with motion reduced. */
  private marksMode(): MarksMode {
    return this.flat || reducedMotion() ? 'none' : 'stage';
  }

  /** The robber goes to `hex`: across the island if he's on it, out of a puff of smoke if he was off it. */
  private async robberTo(hex: number) {
    sfx.play('robber', { at: this.host.state.board.hexes[hex] });
    this.onMap((m) => (m.robberHex = hex));
    if (!this.view.robber.visible) {
      this.showRobber(hex);
      await this.wait(0.5);
    } else if (this.flat) {
      void this.view.moveRobber(hex);
      await this.wait(0.75);
    } else await this.anim(this.view.moveRobber(hex));
  }

  private showRobber(hex: number) {
    this.view.placeRobberAt(hex);
    this.view.robber.visible = true;
    this.view.smokePuff(this.view.robberSpot(hex), 26);
    this.view.crows(hex);
  }

  /** The robber leaves the board (by an expansion's rule): a puff of smoke, and he's gone. */
  private hideRobber(from: number) {
    this.onMap((m) => (m.robberHex = null));
    if (!this.view.robber.visible) return;
    this.view.smokePuff(this.view.robberSpot(from), 26);
    this.view.crows(null);
    this.view.robber.visible = false;
  }

  // --------------------------------------------------------- card flights

  private anchorPoint(target: PlayerId | 'bank' | 'devdeck' | 'center', resource?: Card): { x: number; y: number } {
    const q = (sel: string) => document.querySelector<HTMLElement>(`[data-anchor="${sel}"]`);
    let el: HTMLElement | null = null;
    if (target === 'bank') el = (resource && q(`bank-${resource}`)) || q('bank');
    else if (target === 'devdeck') el = q('devdeck');
    else if (target === 'center') return { x: window.innerWidth / 2, y: window.innerHeight * 0.45 };
    else if (target === this.me) el = (resource && q(`hand-${resource}`)) || q('hand');
    else el = q(`player-${target}`);
    if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** The size the hand's cards are shown at (the hand is zoomed on small screens). */
  private handScale() {
    const el = document.querySelector('[data-anchor="hand-brick"]');
    return el ? el.getBoundingClientRect().width / 92 : 1;
  }

  /**
   * Whether a player's hand is shown by its size alone: online, everyone's but yours (a seat's view
   * holds another's hidden cards as one count, under ore: see engine/view.ts).
   */
  private hiddenHand(p: PlayerId) {
    return !!this.host.remote && (p !== this.me || this.spectating);
  }

  /**
   * Adjust the displayed hand of a player (or the bank) by `n` of each card in `rc` (commodities
   * and oil too). A hand shown by its size takes its hidden kinds on that one count, so its total
   * moves as the cards fly whatever they are.
   */
  private bump(holder: PlayerId | 'bank', rc: Partial<CardCounts>, n: number, gen = this.commitGen) {
    if (gen !== this.commitGen) return;
    const key = holder === 'bank' ? -1 : holder;
    const cur = this.bumps.get(key) ?? emptyCounts();
    const hidden = holder !== 'bank' && this.hiddenHand(holder) ? trackedKinds(this.host.state) : null;
    for (const r of CARDS) cur[hidden?.includes(r) ? 'ore' : r] += (rc[r] ?? 0) * n;
    this.bumps.set(key, cur);
    // (Cards landing together update the hands once, on the next frame, not one store change each.)
    if (!this.bumpFrame) this.bumpFrame = requestAnimationFrame(() => this.flushBumps());
  }

  private bumps = new Map<number, CardCounts>();
  private bumpFrame = 0;

  private flushBumps() {
    this.bumpFrame = 0;
    if (!this.bumps.size) return;
    const s = ui();
    const hd = { ...s.handDelta };
    for (const [k, d] of this.bumps) {
      const cur = { ...(hd[k] ?? emptyCounts()) };
      for (const r of CARDS) cur[r] += d[r];
      hd[k] = cur;
    }
    this.bumps.clear();
    s.set({ handDelta: hd });
  }

  private speed() {
    return animSpeed();
  }

  /**
   * Production. The producing hexes glow; then each card pops up out of its tile, gathers over
   * the settlement or city that earned it (which bobs as it arrives) and flies on to its owner.
   * Cards that never arrive are shown too: those the robber blocks fly to him and crumble, and
   * those the supply can't pay fade where they rise. `voices`: each landscape sounds as it yields
   * (not for oil out of the wells, which already sounded with the roll's own harvest).
   */
  private async flyProduction(grants: { player: PlayerId; hex: number; vertex?: number; resource: Card; amount: number }[], next: GameState, total?: number, lost: LostCard[] = [], voices = true) {
    if (grants.length === 0 && lost.length === 0) return;
    const gen = this.commitGen;
    const store = ui();
    const hexes = [...new Set(grants.map((g) => g.hex))];
    for (const h of hexes) this.world.produce(h);
    if (total && grants.length) sfx.play('produce');
    // Each producing landscape gets its own voice (windmill gust, kiln roar, pickaxes, baa…).
    const terrains = voices ? [...new Set(hexes.map((h) => next.board.hexes[h].terrain))] : [];
    const sp = this.speed();
    terrains.forEach((t, i) => {
      const name = TERRAIN_SFX[t];
      // (Each from the first of its tiles that produced, so the sheep are heard where they are.)
      const at = next.board.hexes[hexes.find((h) => next.board.hexes[h].terrain === t)!];
      if (name) this.later(() => sfx.play(name, { volume: 0.9, at }), (120 + i * 220) / sp);
    });
    await this.wait(0.55);
    const flights: Omit<Flight, 'id'>[] = [];
    const duration = 1.55 / sp;
    // Where roads lead from the tile to the door, a porter carries the harvest home along them.
    if (!this.flat) this.view.harvestCarts(grants.flatMap((g) => (g.vertex === undefined ? [] : [{ player: g.player, vertex: g.vertex, hex: g.hex, resource: g.resource }])), duration * 0.9);
    // Stagger: each building's cards follow each other closely; buildings take turns, and the
    // whole volley is kept under about a second however many cards there are.
    const count = grants.reduce((n, g) => n + g.amount, 0) + lost.reduce((n, l) => n + l.amount, 0);
    const step = Math.min(0.09, 1 / Math.max(1, count)) / sp;
    let k = 0;
    const taken = emptyCounts();
    for (const g of grants) {
      const from = this.view.hexScreen(g.hex);
      const via = g.vertex !== undefined ? this.view.buildingScreen(g.vertex) : undefined;
      const player = g.player;
      const res = g.resource;
      const vertex = g.vertex;
      for (let i = 0; i < g.amount; i++) {
        const delay = k++ * step;
        taken[res]++;
        flights.push({
          kind: 'resource',
          resource: res,
          from,
          via: via && { x: via.x + (i - (g.amount - 1) / 2) * 16, y: via.y },
          rise: true,
          to: this.anchorPoint(player, res),
          delay,
          duration,
          rotate: (Math.random() - 0.5) * 40,
          scale: player === this.me ? 1 : 0.6,
          endScale: player === this.me ? this.handScale() : 0.3,
          onLand: () => {
            this.bump(player, { [res]: 1 }, 1, gen);
            sfx.play('cardLand');
          },
        });
        if (vertex !== undefined && i === 0) {
          // On the island, the harvest arcs from the tile to the building as the card leaves the
          // tile, and the building bobs as it (and its card) arrive.
          const amount = g.amount;
          this.later(() => this.view.harvestArc(g.hex, vertex, HARVEST_GLOW[res] ?? '#f2e6c4', duration * 0.21, amount), (delay + duration * 0.17) * 1000);
          this.later(() => this.view.receiveAt(vertex, player), (delay + duration * 0.38) * 1000);
        }
      }
    }
    for (const l of lost) {
      const from = this.view.hexScreen(l.hex);
      const blocked = l.reason === 'blocked';
      // (To whichever blocker stops it: the robber, the raiders' camp, the corsair off the coast.)
      const blocker = this.view.blockerSpot(l.hex);
      blocker.y += 0.22;
      const to = blocked ? this.view.toScreen(blocker) : { x: from.x, y: from.y - 70 };
      for (let i = 0; i < l.amount; i++) {
        const delay = k++ * step;
        flights.push({ kind: 'resource', resource: l.resource, from, to, fizzle: true, delay, duration: duration * 0.85, rotate: (Math.random() - 0.5) * 30, scale: 0.6 });
      }
    }
    // The blocker snatches the cards headed its way: a puff as they reach it.
    for (const h of new Set(lost.filter((l) => l.reason === 'blocked').map((l) => l.hex))) {
      this.later(() => this.view.smokePuff(this.view.blockerSpot(h), 14), duration * 0.72 * 1000);
    }
    this.bump('bank', taken, -1);
    store.addFlights(flights);
    await this.wait((duration + k * step) * sp + 0.1);
  }

  /** Move cards between two holders (player / bank) with flights. */
  private async flyCards(from: PlayerId | 'bank', to: PlayerId | 'bank', rc: CardCounts, o: { faceDown?: boolean; via?: { x: number; y: number } }, delayStart = 0) {
    const flights: Omit<Flight, 'id'>[] = [];
    const gen = this.commitGen;
    const sp = this.speed();
    let k = 0;
    const hand = this.handScale();
    for (const r of CARDS) {
      for (let i = 0; i < rc[r]; i++) {
        const fromP = this.anchorPoint(from, r);
        const toP = this.anchorPoint(to, r);
        const target = to;
        const delay = (delayStart + k++ * 0.07) / sp;
        // Each card leaves its holder as its own flight sets off.
        this.later(() => this.bump(from, { [r]: 1 }, -1, gen), delay * 1000);
        flights.push({
          kind: o.faceDown ? 'resourceBack' : 'resource',
          resource: r,
          from: fromP,
          to: toP,
          via: o.via,
          delay,
          duration: (o.via ? 1.3 : 0.7) / sp,
          rotate: (Math.random() - 0.5) * 30,
          scale: from === this.me || to === this.me ? 0.9 : 0.6,
          startScale: from === this.me && !o.via ? hand : undefined,
          endScale: to === this.me ? hand : to === 'bank' ? 0.4 : 0.3,
          onLand: () => {
            this.bump(target, { [r]: 1 }, 1, gen);
            sfx.play('cardLand');
          },
        });
      }
    }
    if (!flights.length) return;
    ui().addFlights(flights);
    await this.wait((o.via ? 1.3 : 0.7) + delayStart + k * 0.07 + 0.05);
  }

  private async payCost(player: PlayerId, cost: CardCounts) {
    await this.flyCards(player, 'bank', cost, {});
  }

  /** Cards leaving the game (oil a polluted well spoils, oil sequestered): each lifts off its holder, greys and crumbles. */
  private async loseCards(holder: PlayerId | 'bank', rc: CardCounts) {
    const flights: Omit<Flight, 'id'>[] = [];
    const gen = this.commitGen;
    const sp = this.speed();
    let k = 0;
    for (const r of CARDS) {
      for (let i = 0; i < rc[r]; i++) {
        const from = this.anchorPoint(holder, r);
        const delay = (k++ * 0.09) / sp;
        this.later(() => this.bump(holder, { [r]: 1 }, -1, gen), delay * 1000);
        flights.push({ kind: 'resource', resource: r, from, to: { x: from.x, y: from.y - 70 }, fizzle: true, delay, duration: 0.9 / sp, rotate: (Math.random() - 0.5) * 30, scale: holder === this.me ? 0.9 : 0.6 });
      }
    }
    if (!flights.length) return;
    ui().addFlights(flights);
    await this.wait(0.9 + k * 0.09 + 0.05);
  }

  private async flyDev(player: PlayerId, card: DevCardType | null, variant: number) {
    const sp = this.speed();
    ui().addFlights([
      {
        kind: card ? 'dev' : 'devBack',
        dev: card ?? undefined,
        variant,
        from: this.anchorPoint('devdeck'),
        to: player === this.me ? this.anchorPoint(this.me, undefined) : this.anchorPoint(player),
        delay: 0,
        duration: 0.9 / sp,
        rotate: 8,
        scale: player === this.me ? 1.1 : 0.6,
      },
    ]);
    await this.wait(0.95);
  }

  /** The bonus tile card is shown, then flies from its previous holder (or the centre) to the new one. */
  private async flyBonus(kind: 'longestRoute' | 'largestArmy', from: PlayerId | null, to: PlayerId) {
    const sp = this.speed();
    // Shown below the middle so it never covers the announcement banners at the top.
    const mid = this.anchorPoint('center');
    const center = { x: mid.x, y: mid.y + window.innerHeight * 0.1 };
    ui().addFlights([
      { kind: 'bonus', bonus: kind, from: from === null ? center : this.anchorPoint(from), to: center, delay: 0, duration: 1.3 / sp, rotate: 0, scale: 1.9 },
    ]);
    await this.wait(1.2);
    sfx.play('whoosh');
    ui().addFlights([{ kind: 'bonus', bonus: kind, from: center, to: this.anchorPoint(to), delay: 0, duration: 0.8 / sp, rotate: -6, scale: 0.7 }]);
    await this.wait(0.85);
  }

  /**
   * A token won (the raider fleet's defence token): it lifts off the banner's painting, is held up
   * below it a moment, and flies to its holder's tokens (yours beside the expansions' moves).
   */
  private async flyToken(art: string, to: PlayerId) {
    const sp = this.speed();
    const mid = this.anchorPoint('center');
    const el = document.querySelector('.banner .banner-art') ?? document.querySelector('.banner');
    const r = el?.getBoundingClientRect();
    const from = r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: mid.x, y: window.innerHeight * 0.14 };
    // Held up just under the painting it came off (never lower than where the award tiles are shown).
    const center = { x: from.x, y: Math.min(from.y + 190, mid.y + window.innerHeight * 0.1) };
    ui().addFlights([{ kind: 'token', art, from, to: center, delay: 0, duration: 1.2 / sp, rotate: 0, scale: 1.7 }]);
    await this.wait(1.1);
    sfx.play('whoosh');
    ui().addFlights([{ kind: 'token', art, from: center, to: this.tokenRow(to), delay: 0, duration: 0.8 / sp, rotate: -8, scale: 0.6, endScale: 0.3, onLand: () => sfx.play('cardLand') }]);
    await this.wait(0.85);
  }

  /** Where a player's tokens are shown: yours beside the expansions' moves, another's on their panel. */
  private tokenRow(p: PlayerId): { x: number; y: number } {
    const row = p === this.me ? document.querySelector('.module-coins') : null;
    const r = row?.getBoundingClientRect();
    return r && r.width > 0 ? { x: r.right - 14, y: r.top + r.height / 2 } : this.anchorPoint(p);
  }

  private async showPlayedCard(player: PlayerId, card: DevCardType) {
    const sp = this.speed();
    ui().addFlights([
      {
        kind: 'dev',
        dev: card,
        from: this.anchorPoint(player),
        to: this.anchorPoint('center'),
        delay: 0,
        duration: 1.5 / sp,
        rotate: 0,
        scale: 2.2,
      },
    ]);
    await this.wait(1.6);
  }

  dispose() {
    this.disposed = true;
    this.talk?.dispose();
    if (this.host.onError) this.host.onError = null;
    this.unsub();
    this.unsubModal();
    if (this.botTimer) clearTimeout(this.botTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.bumpFrame) cancelAnimationFrame(this.bumpFrame);
  }
}

// ------------------------------------------------------------------ helpers

/** The glow of each harvest on its way across the island (brighter than the cards' tints). */
const HARVEST_GLOW: Partial<Record<Card, string>> = {
  brick: '#ff8a5c',
  wood: '#9be07a',
  wool: '#f6f3e8',
  wheat: '#ffd76a',
  ore: '#bcd3ea',
};

const TERRAIN_SFX: Record<string, Parameters<typeof sfx.play>[0] | undefined> = {
  forest: 'produceForest',
  fields: 'produceFields',
  pasture: 'producePasture',
  hills: 'produceHills',
  mountains: 'produceMountains',
};

interface LostCard {
  hex: number;
  resource: Card;
  amount: number;
  /** What kept it: a blocker on the hex (each takes the cards to itself), or a supply run short. */
  reason: 'blocked' | 'supply';
}

/** How a theft no blocker made came about, after its line ("… with fish"). */
const STEAL_WORDS: Record<StealCause, string> = {
  fish: ' with fish',
  almanac: '',
  warden: ' in the chase',
  venture: ' by a venture',
  seven: ' on the 7',
};

/** How long a seven's numeral takes to rise out of the sea over the island's dice (fx/diceTotal.ts). */
const SEVEN_RISE = 0.62;
/** When the flat map's dice are at rest (FlatBoard's SETTLED). */
const FLAT_SETTLED = 0.95;

/**
 * A roll's two pauses, in animation seconds: from the throw until its line is logged and the board
 * answers (the dice down), and after a seven's banner, before what follows. A seven that costs you
 * half your hand holds the second until the dice are at rest (THROW_TIME on the island, sooner on
 * the flat map), the seven has risen over them and has had a moment to be read: the dialog asking
 * for the cards stands where the dice float on a foldable, and the cause should come before the
 * cost. A seven that asks nothing of you (so any replay too) keeps its usual beat; the bots
 * discard once the roll has been shown, either way.
 */
export function rollPauses(seven: boolean, flat: boolean, owe: boolean): [landed: number, after: number] {
  const landed = flat ? 1.05 : 1.35;
  if (!seven) return [landed, 0];
  const seen = (flat ? FLAT_SETTLED : THROW_TIME + SEVEN_RISE) + 0.8;
  return [landed, owe ? Math.max(0.6, seen - landed) : 0.6];
}

/** What a 7 sets moving, by the blockers the game has (see tableWords' `sevenBlockers`). */
function sevenStirs(s: GameState): string {
  if (blockersHeld(s)) return 'Nothing stirs until the raiders come';
  const b = sevenBlockers(s);
  if (b.length === 2) return 'The robber and the corsair stir…';
  return b.length ? `The ${b[0]} stirs…` : 'A thief is about…';
}

/**
 * Cards a roll would have produced but didn't, as the engine itself reckons a hex's yield
 * (`hexGrants`: a foundry's three, a Guilds city's resource and commodity, a sick city's one): a
 * blocked hex yields nothing, and when the supply can't cover everyone a card goes to nobody (or
 * only part of it to one player).
 */
export function lostCards(s: GameState, e: Extract<GameEvent, { type: 'production' }>): LostCard[] {
  const out: LostCard[] = [];
  for (const hex of s.board.hexes) {
    if (!numbersOf(s, hex).includes(e.total)) continue;
    const blocked = e.blockedHexes.includes(hex.id);
    for (const g of hexGrants(s, hex.id)) {
      if (!blocked && !e.shortages.includes(g.resource)) continue;
      const got = blocked ? 0 : e.grants.filter((x) => x.vertex === g.vertex && x.hex === g.hex && x.resource === g.resource).reduce((n, x) => n + x.amount, 0);
      if (g.amount > got) out.push({ hex: hex.id, resource: g.resource, amount: g.amount - got, reason: blocked ? 'blocked' : 'supply' });
    }
  }
  return out;
}

/**
 * The game as of event `at` of a host message, for the expansions' pieces. The host sends one state
 * per action, so whatever later events in the same message move is wound back to where it stood
 * before them: raiders landing, taken prisoner, led along the coast or driven off, the corsair, ships,
 * the raider fleet's steps. Everything else is as the message leaves it.
 */
export function stagedState(next: GameState, events: readonly GameEvent[], at: number): GameState {
  const inv = next.ext.invasion, sea = next.ext.sea, fleet = next.ext.fleet;
  let raiders: number[] | null = null;
  let corsair: number | null | undefined;
  let routes: GameState['routes'] | null = null;
  let position: number | undefined;
  const r = () => (raiders ??= [...inv!.raiders]);
  const rs = () => (routes ??= [...next.routes]);
  for (let j = events.length - 1; j > at; j--) {
    const e = events[j];
    switch (e.type) {
      case 'invasion/landed':
        // (Its count is the hex's after it landed.)
        if (inv && e.hex !== null) r()[e.hex] = e.raiders - 1;
        break;
      case 'invasion/battle':
        if (inv) r()[e.hex] = e.raiders;
        break;
      case 'invasion/captured':
      case 'guilds/raiderCaptured':
        if (inv) r()[e.hex]++;
        break;
      case 'invasion/raidersLed':
        if (inv)
          for (const m of [...e.moves].reverse()) {
            r()[m.to]--;
            if (m.from !== null) r()[m.from]++;
          }
        break;
      case 'sea/corsairMoved':
      case 'almanac/corsairFled':
        corsair = e.from;
        break;
      case 'fisheries/blockerRemoved':
      case 'garrisons/chased':
        if (e.blocker === 'corsair') corsair = e.from;
        break;
      case 'fleet/blockersIn':
        // (Till the first attack the corsair waits off the board.)
        if (e.corsair !== null) corsair = null;
        break;
      case 'sea/shipBuilt':
        rs()[e.edge] = null;
        break;
      case 'sea/shipMoved':
        rs()[e.from] = rs()[e.to];
        rs()[e.to] = null;
        break;
      case 'fleet/advanced':
        position = e.position - 1;
        break;
    }
  }
  // The fleet as of its own step (an attack after it in the message sends it back to the start).
  const own = events[at];
  if (own?.type === 'fleet/advanced') position = own.position;
  // (Assigned in the closures above, which the compiler doesn't follow.)
  const wound = raiders as number[] | null, ships = routes as GameState['routes'] | null;
  if (!wound && corsair === undefined && !ships && (position === undefined || position === fleet?.position)) return next;
  const ext = { ...next.ext };
  if (wound && inv) ext.invasion = { ...inv, raiders: wound };
  if (corsair !== undefined && sea) ext.sea = { ...sea, corsair };
  if (position !== undefined && fleet) ext.fleet = { ...fleet, position };
  return { ...next, routes: ships ?? next.routes, ext };
}

/** The harbour of `player`'s that gives `give` at `rate` (its own 2:1, or a general 3:1), or null when that rate came from elsewhere. */
export function harbourFor(s: GameState, player: PlayerId, give: Card, rate: number): Card | 'any' | null {
  const mine = s.board.ports.filter((p) => p.vertices.some((v) => s.buildings[v]?.owner === player));
  if (rate === 2 && mine.some((p) => p.type === give)) return give;
  // (A general harbour takes commodities at 3:1 too, when the Guilds have them.)
  if (rate === 3 && mine.some((p) => p.type === 'any')) return 'any';
  return null;
}

/** The awards an undo took back, between the game as shown and as it is now: a line each. */
export function awardsUndone(before: GameState | null, next: GameState, isMe: (p: PlayerId) => boolean): { player: PlayerId | null; text: string }[] {
  if (!before) return [];
  const out: { player: PlayerId | null; text: string }[] = [];
  const who = (p: PlayerId) => (isMe(p) ? 'you' : next.players[p].name);
  const award = (title: string, was: PlayerId | null | undefined, now: PlayerId | null | undefined) => {
    if (was === undefined || now === undefined || was === now) return;
    out.push({ player: now ?? was, text: now === null ? `${title} goes back to the supply` : `${title} goes back to ${who(now)}` });
  };
  award('The Port Captain award', before.ext.harbourmaster?.holder, next.ext.harbourmaster?.holder);
  award('The Richest tile', before.ext.rivers?.richest, next.ext.rivers?.richest);
  award('The Steward’s title', before.ext.oil?.steward, next.ext.oil?.steward);
  const was = before.ext.sea?.landed, now = next.ext.sea?.landed;
  if (was && now) {
    next.players.forEach((p) => {
      for (const isl of was[p.id] ?? []) {
        if ((now[p.id] ?? []).includes(isl)) continue;
        const first = isMe(p.id) ? 'Your' : `${p.name}’s`;
        out.push({ player: p.id, text: `${first} first landing on ${islandName(next, isl)} is taken back` });
      }
    });
  }
  return out;
}

/** The ground each terrain gives a piece to land on. */
const GROUND: Record<string, Ground> = { mountains: 'stone', hills: 'clay', fields: 'earth', pasture: 'grass', forest: 'leaves', desert: 'sand', bounty: 'earth', swamp: 'grass', lake: 'grass', oasis: 'sand', castle: 'stone' };
/** Harder grounds carry the sound: where tiles meet, the hardest of them is heard. */
const HARDNESS: Ground[] = ['stone', 'clay', 'earth', 'leaves', 'grass', 'sand'];

/** What a piece on these tiles lands on, and whether the sea is right there (fewer tiles than `full`: a corner has three inland, an edge two). */
function groundAt(s: GameState, hexes: readonly number[], full = 3): { ground: Ground; wet: boolean } {
  const gs = hexes.map((h) => GROUND[s.board.hexes[h].terrain] ?? 'grass');
  // The most of one kind wins; a tie goes to the harder.
  const count = (g: Ground) => gs.filter((x) => x === g).length;
  const ground = [...new Set(gs)].sort((a, b) => count(b) - count(a) || HARDNESS.indexOf(a) - HARDNESS.indexOf(b))[0] ?? 'grass';
  return { ground, wet: hexes.length < full };
}

/** The tiles either side of an edge. */
function edgeHexes(s: GameState, edge: number) {
  const ed = s.board.edges[edge];
  const a = s.board.vertices[ed.a].hexes, b = s.board.vertices[ed.b].hexes;
  return a.filter((h) => b.includes(h));
}

/** The middle of an edge, where a road's sound comes from. */
function edgeAt(s: GameState, edge: number) {
  const ed = s.board.edges[edge];
  const a = s.board.vertices[ed.a], b = s.board.vertices[ed.b];
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

function terrainRes(s: GameState, hex: number) {
  return TERRAIN_RESOURCE[s.board.hexes[hex].terrain];
}

function neg(rc: CardCounts): CardCounts {
  const out = emptyCounts();
  for (const k of CARDS) out[k] = -rc[k];
  return out;
}

/** The kind a card of unknown kind is counted as on its way (a hidden hand counts every hidden kind as one). */
const HIDDEN_CARD: Card = 'ore';

function single(r: Card): CardCounts {
  const c = emptyCounts();
  c[r] = 1;
  return c;
}

function countOf(rc: CardCounts) {
  return CARDS.reduce((n, r) => n + rc[r], 0);
}

/** A count of a resource in a log line, drawn as its icon (see the log panel). */
function token(n: number, r: Card) {
  return `{${n}:${r}}`;
}

function describe(rc: CardCounts) {
  return CARDS.filter((r) => rc[r] > 0)
    .map((r) => token(rc[r], r))
    .join(' ');
}

