// Table talk. The other players chat as the game goes: greetings, groans when they're robbed,
// gloating over a steal, pride in a new city, and replies when you talk to them (asked for a
// resource, they answer from what you can see they hold). Each has a voice of their own, and they
// speak now and then, never all at once. They bargain too: a bot proposing a trade pitches it, and
// asked for a resource on your turn, a bot names a deal it would truly take, which you can offer
// with one click. They only ever own up to cards you could know they hold (the card tracker), so
// asking round the table never gives away a hidden hand.
//
// This is the pure core: what is said and when is decided here, and the speaking itself goes
// through a TalkIO (the clock, the dice and where a line goes). game/chat.ts puts the lines in the
// table's chat after their delay; the room server sends them to the seats.

import { RESOURCES, emptyCards, handEstimate, hasResources, publicVictoryPoints, victoryTarget, type GameEvent, type GameState, type PlayerId, type Resource, type CardCounts } from '../engine';
import { wouldAccept, type BotDifficulty } from '../engine/ai';
import type { BotPersonality } from '../engine/ai/profiles';
import { botProfile, personalityOf } from './host';
import { CARD_NAMES } from './names';
import { blockersHeld, sevenBlockers } from './tableWords';

type Moment =
  | 'hello' | 'robbed' | 'stole' | 'seven' | 'bounty' | 'city' | 'settlement' | 'longest' | 'army' | 'close'
  | 'won' | 'lost' | 'cheer' | 'thanks' | 'luck' | 'trade' | 'tradeNo' | 'robberAsk' | 'generic' | 'monopolyHit' | 'traded'
  | 'pitch' | 'deal'
  // A 7 by the blockers in play (the robber's 'seven', the corsair alone, or neither), and the expansions' moments.
  | 'sevenCorsair' | 'sevenQuiet' | 'landing' | 'sacked' | 'freed' | 'disaster';

type Lines = Partial<Record<Moment, string[]>>;

export const PLAIN: Lines = {
  hello: ['Hello, all. Good luck.', 'Let’s see how this one goes.'],
  robbed: ['Hey, {thief}! That was mine.', 'Really, {thief}?'],
  stole: ['Sorry, {victim}.', 'Thanks, {victim}.'],
  seven: ['A seven. Here comes the robber.'],
  sevenCorsair: ['A seven. The corsair is coming.'],
  sevenQuiet: ['A seven. Mind your hands.'],
  landing: ['First ashore.'],
  sacked: ['My town, sacked.'],
  freed: ['That hex is free again.'],
  disaster: ['A hard blow for the island.'],
  bounty: ['A good haul.', 'That helps.'],
  city: ['A town at last.'],
  settlement: ['A new house.'],
  longest: ['The longest route is mine.'],
  army: ['The biggest army is mine.'],
  close: ['Getting close now.'],
  won: ['Good game, everyone.'],
  lost: ['Well played, {winner}.'],
  cheer: ['Well played. You earned it.'],
  thanks: ['Thanks.'],
  luck: ['Good luck to you too.'],
  trade: ['I have some {r}. Make me an offer.'],
  tradeNo: ['No {r} to spare, sorry.'],
  robberAsk: ['The robber goes where it hurts most.'],
  generic: ['Hm.', 'Fair enough.', 'We’ll see.'],
  monopolyHit: ['All of them, {player}?'],
  traded: ['Good trade.'],
  pitch: ['Anyone have {get}? I’ll give {give}.'],
  deal: ['I’ll give you {get} for {give}.'],
};

/**
 * The bots' voices, by character (names.ts says which crew member has which): a sea captain's trader,
 * a cheerful settler, a gruff smith and a wise elder. A voice never names a crew member, so any of
 * them can speak it.
 */
const VOICES: Record<BotPersonality, Lines> = {
  trader: {
    hello: ['Ahoy, all. Fair winds to you.', 'Hands on deck. Let’s see who rules these waters.', 'A fine day for building an empire, eh?'],
    robbed: ['Blast it, {thief}! Those were honest goods.', 'Plundered in my own harbour, {thief}!', 'Mark my words, {thief}, the tide turns.'],
    stole: ['Finders keepers, {victim}.', 'A small harbour tax, {victim}. Nothing personal.', 'Ha! A fine prize.'],
    seven: ['Seven! Batten down the hatches.', 'There goes the robber again. Mind your holds.'],
    sevenCorsair: ['Seven! Watch for black sails.', 'The corsair’s out. Guard your cargo.'],
    sevenQuiet: ['Seven. Lighten your holds, mates.'],
    landing: ['Land ho! First boots on the beach.', 'Planted my colours before anyone.'],
    sacked: ['They sacked my town, the dogs!', 'Raiders in my harbour. They’ll pay.'],
    freed: ['Cleared the shore. Good work.', 'That beach is ours again.'],
    disaster: ['Foul weather on this isle.', 'Batten down. It’ll pass.'],
    bounty: ['A full hold today!', 'The sea provides.', 'Now that’s a haul worth writing home about.'],
    city: ['A proper town, with a proper harbour.', 'Raise the flags, we’ve a town!'],
    settlement: ['Another port of call.', 'Planting my flag here.'],
    longest: ['Every road leads to my harbour now.', 'Charted the longest course on the isle.'],
    army: ['My knights sail under one flag now.', 'The biggest army flies my colours.'],
    close: ['I can smell victory on the breeze.', 'Nearly home, mates.'],
    won: ['Victory! Drinks are on me.', 'The isle is mine. Well sailed, everyone.'],
    lost: ['Well sailed, {winner}. The next voyage is mine.', 'Bah. Congratulations, {winner}.'],
    cheer: ['Well sailed. You’ve earned your harbour.'],
    thanks: ['Much obliged.', 'Kind words, matey.'],
    luck: ['And to you. You’ll need it.', 'Luck’s for landlubbers. But thank you.'],
    trade: ['I’ve {r} to spare. Make me an offer.', '{R}? Could be arranged, for the right price.'],
    tradeNo: ['My {r} stays in the hold.', 'No {r} for sale, sorry.'],
    robberAsk: ['That robber’s a scoundrel. Keep him off my shores.'],
    generic: ['Aye.', 'Hm. We’ll see.', 'Ha! Is that so?', 'Keep your eyes on the board, matey.'],
    monopolyHit: ['Every last one? Pirate.', 'You’ve emptied my hold, {player}.'],
    traded: ['Pleasure doing business.', 'A fair trade. Don’t spend it all at once.'],
    pitch: ['Who’ll trade me {get}? There’s {give} in it for you.', 'Looking for {get}. Paying {give}.'],
    deal: ['{Get} for {give}, and that’s a bargain.', 'I’ll part with {get} for {give}, matey.'],
  },
  settler: {
    hello: ['Hello everyone! Good luck!', 'Hi all! I’ve got a good feeling about this one.', 'Oh, this island looks lovely.'],
    robbed: ['Hey! {thief}, that was mine!', 'Aw, really, {thief}?', 'Not my wool, {thief}!'],
    stole: ['Sorry, {victim}! I’ll make it up to you. Maybe.', 'Oops. Thanks, {victim}!', 'Don’t be cross, {victim}.'],
    seven: ['Oh no, a seven.', 'Everyone hide your cards!'],
    sevenCorsair: ['A seven! Is that the corsair?', 'Oh dear, the corsair again.'],
    sevenQuiet: ['A seven! Hide your cards, everyone.'],
    landing: ['Look, a whole new island!', 'I got there first!'],
    sacked: ['Oh no, my lovely town!', 'They took everything!'],
    freed: ['Hooray, they’ve gone!', 'The fields are safe again.'],
    disaster: ['Oh, the poor island.', 'That’s just awful.'],
    bounty: ['Look at all that!', 'What a harvest!', 'Yes! Just what I needed.'],
    city: ['A town! I’m so proud of it.', 'My little village grew up.'],
    settlement: ['A new home by the fields.', 'Moving in!'],
    longest: ['Longest route! I do love a long walk.', 'All those roads paid off!'],
    army: ['My knights are the best knights.', 'Biggest army, who knew?'],
    close: ['Ooh, I’m getting close!', 'Just a little more…'],
    won: ['I won? I won! Thank you all!', 'That was so much fun. Good game, everyone!'],
    lost: ['Congratulations, {winner}! Well played.', 'Good game! Rematch?'],
    cheer: ['Congratulations! That was brilliant.'],
    thanks: ['Thank you! You too!', 'Aw, thanks!'],
    luck: ['Good luck to you too!', 'Thanks! Have fun!'],
    trade: ['I’ve got some {r}! Want to trade?', 'I could spare a little {r}. Send an offer!'],
    tradeNo: ['Sorry, I’m short on {r} myself.', 'No {r} here, sorry!'],
    robberAsk: ['Please don’t put the robber near my wool.'],
    generic: ['Ha, true!', 'Hmm, maybe!', 'Oh, I hadn’t thought of that.', 'Fair enough!'],
    monopolyHit: ['All of it? That’s so mean!', 'Hey, I needed those, {player}!'],
    traded: ['Thanks for the trade!', 'That works for me!'],
    pitch: ['Anyone got {get}? I’ve {give} to swap!', 'I need {get}! {Give} for it?'],
    deal: ['I can do {get} for {give}!', 'How about {get} for {give}?'],
  },
  smith: {
    hello: ['Let’s get to work.', 'Morning.', 'Hope you brought ore.'],
    robbed: ['{thief}. I won’t forget that.', 'Hmph. Thief.', 'Watch yourself, {thief}.'],
    stole: ['Taking that, {victim}.', 'Mine now.', 'Business, {victim}. Just business.'],
    seven: ['Seven. Typical.', 'There goes the robber.'],
    sevenCorsair: ['Seven. The corsair.', 'Corsair’s loose again.'],
    sevenQuiet: ['Seven. Too many cards, lose half.'],
    landing: ['New ground. Mine.', 'First on it.'],
    sacked: ['My walls. Gone.', 'Raiders. Should’ve built thicker.'],
    freed: ['Good. Back to work.', 'Shifted them.'],
    disaster: ['Bad business.', 'Mess like that, we all pay.'],
    bounty: ['Good. Plenty to work with.', 'That’ll keep the forge hot.'],
    city: ['Built to last.', 'Stone walls. Proper ones.'],
    settlement: ['Another outpost.', 'Good ground.'],
    longest: ['Longest route. Roads take sweat.', 'The longest route. Mine.'],
    army: ['Biggest army. Forged every blade myself.', 'My knights hold the line.'],
    close: ['Almost done here.', 'Few more swings.'],
    won: ['Done. Good game.', 'Hard work pays. Good game, all.'],
    lost: ['Well done, {winner}.', 'Next time, {winner}.'],
    cheer: ['Solid work. Well done.'],
    thanks: ['Thanks.', 'Hm. Appreciated.'],
    luck: ['Luck’s nothing. Work is everything.', 'You too.'],
    trade: ['Got {r}. What are you offering?', '{R}, yes. Make it worth my while.'],
    tradeNo: ['No {r} to spare.', 'Need my {r}.'],
    robberAsk: ['Robber goes wherever hurts most. That’s the game.'],
    generic: ['Hm.', 'If you say so.', 'Fair.', 'Less talk, more building.'],
    monopolyHit: ['All of it? Robbery.', 'Hmph. Clever, {player}.'],
    traded: ['Fair deal.', 'Done.'],
    pitch: ['Need {get}. Paying {give}.', '{Give} for {get}. Who’s in?'],
    deal: ['{Get} for {give}. Deal?', '{Give} and the {get}’s yours.'],
  },
  scholar: {
    hello: ['Greetings, friends. May the dice be kind.', 'Ah, a new island. How promising.', 'Welcome, all. Let us build wisely.'],
    robbed: ['Ah, {thief}. A lesson in patience, then.', 'A lesson in humility, it seems.', 'I shall remember this, {thief}.'],
    stole: ['Forgive me, {victim}. The road demands it.', 'A necessary unkindness, {victim}.', 'Fortune shifts, {victim}.'],
    seven: ['Seven. The great balancer.', 'Ah, the robber stirs again.'],
    sevenCorsair: ['A seven. The corsair stirs on the water.', 'The sea brings its own thief.'],
    sevenQuiet: ['A seven. Those who hoard will regret it.'],
    landing: ['Fortune favours the bold traveller.', 'A new shore, a new chapter.'],
    sacked: ['Towns rise, towns fall.', 'Even stone walls are only patience.'],
    freed: ['Patience frees the land.', 'The raiders were only passing through.'],
    disaster: ['The island reminds us who rules it.', 'What we take, we answer for.'],
    bounty: ['The land is generous today.', 'Patience, rewarded.'],
    city: ['A town rises, as all good plans do.', 'From village to town. Splendid.'],
    settlement: ['A modest home, well placed.', 'Every journey begins with a single house.'],
    longest: ['The longest route is merely the most patient one.', 'All roads lead somewhere. Mine lead furthest.'],
    army: ['My knights grow in number, and in wisdom.', 'The biggest army, though I prefer peace.'],
    close: ['The end draws near, I sense.', 'Not long now.'],
    won: ['A fine game. Thank you, friends.', 'Victory is sweet, but the company sweeter.'],
    lost: ['Well played, {winner}. A worthy victory.', 'Congratulations, {winner}. I learned a great deal.'],
    cheer: ['A worthy victory. I learned a great deal.'],
    thanks: ['You are too kind.', 'Thank you, friend.'],
    luck: ['And to you, though luck favours the prepared.', 'Thank you. May your dice roll true.'],
    trade: ['I have {r} to share. Propose something fair.', 'Some {r} could be spared, for a fair exchange.'],
    tradeNo: ['Alas, I need my {r}.', 'I have no {r} to spare, I fear.'],
    robberAsk: ['The robber follows wealth. Spread yours wisely.'],
    generic: ['Indeed.', 'An interesting thought.', 'Hmm, perhaps.', 'Wisely said.'],
    monopolyHit: ['Every card? Bold, {player}.', 'A cunning stroke, {player}.'],
    traded: ['A fair exchange.', 'Good trading, friend.'],
    pitch: ['I seek {get}, and offer {give} in return.', 'Might anyone spare {get}? I have {give}.'],
    deal: ['I could offer {get} for your {give}.', '{Get} for {give} seems fair to me.'],
  },
};

/** Words that name each resource in a message. */
const RESOURCE_WORDS: Record<Resource, RegExp> = {
  brick: /\b(brick|bricks|clay)\b/,
  wood: /\b(wood|lumber|logs?|timber)\b/,
  wool: /\b(wool|sheep)\b/,
  wheat: /\b(wheat|grain)\b/,
  ore: /\b(ore|stone|rock)\b/,
};

/** A line a bot says: after `delay` ms, as `moment` (an offer it would take, for a deal). */
export interface TalkLine {
  player: PlayerId;
  text: string;
  moment: string;
  delay: number;
  offer?: { to: PlayerId; give: CardCounts; get: CardCounts };
}

/** What the talk needs from where it runs: a clock (ms), a die in [0, 1), and somewhere to say a line. */
export interface TalkIO {
  now(): number;
  random(): number;
  emit(line: TalkLine): void;
}

export class TalkCore {
  /** Unprompted remarks wait until this time (ms), so the table isn't noisy. */
  private quietUntil = 0;
  private greeted = false;
  private nearlyThere = new Set<PlayerId>();

  constructor(
    private me: PlayerId,
    private state: () => GameState,
    private difficulty: (p: PlayerId) => BotDifficulty,
    private io: TalkIO,
  ) {}

  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.io.random() * xs.length)];
  }

  private bots() {
    return this.state().players.filter((p) => p.isBot && p.id !== this.me).map((p) => p.id);
  }

  /** How a player is named in a line: "you" for the person playing. */
  private called(p: PlayerId) {
    return p === this.me ? 'you' : this.state().players[p].name;
  }

  /**
   * `p` says something for `moment` (with `{name}` slots filled from `vars`), with probability
   * `chance`. A reply to you is always heard; remarks of their own wait for a lull.
   */
  private say(p: PlayerId, moment: Moment, vars: Record<string, string> = {}, o: { chance?: number; reply?: boolean; after?: number; offer?: { give: CardCounts; get: CardCounts } } = {}) {
    if (this.io.random() > (o.chance ?? 1)) return;
    const now = this.io.now();
    if (!o.reply && now < this.quietUntil) return;
    const voice = personalityOf(this.state().players[p].name);
    const lines = (voice && VOICES[voice][moment]) ?? PLAIN[moment];
    if (!lines?.length) return;
    let text = this.pick(lines);
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, v).replaceAll(`{${k.toUpperCase()}}`, v[0].toUpperCase() + v.slice(1));
    }
    const delay = (o.after ?? 0) + 700 + this.io.random() * 1600;
    this.quietUntil = now + delay + 5000;
    this.io.emit({ player: p, text, moment, delay, offer: o.offer && { to: p, ...o.offer } });
  }

  /** React to something happening in the game. */
  onEvent(e: GameEvent) {
    const bots = this.bots();
    const isBot = (p: PlayerId | null): p is PlayerId => p !== null && bots.includes(p);
    switch (e.type) {
      case 'firstPlayerChosen':
      case 'turnStarted': {
        if (this.greeted) return;
        this.greeted = true;
        bots.forEach((b, i) => this.say(b, 'hello', {}, { chance: 0.55, reply: true, after: i * 1800 }));
        return;
      }
      case 'diceRolled': {
        if (e.total !== 7) return;
        const others = bots.filter((b) => b !== e.player);
        // (What a 7 stirs follows the blockers this game has, and whether the raider fleet still holds them off.)
        const s = this.state();
        const stirs = blockersHeld(s) ? [] : sevenBlockers(s);
        const moment: Moment = stirs.includes('robber') ? 'seven' : stirs.includes('corsair') ? 'sevenCorsair' : 'sevenQuiet';
        if (others.length) this.say(this.pick(others), moment, {}, { chance: 0.3 });
        return;
      }
      case 'production': {
        const got = new Map<PlayerId, number>();
        for (const g of e.grants) got.set(g.player, (got.get(g.player) ?? 0) + g.amount);
        const lucky = [...got].filter(([p, n]) => isBot(p) && n >= 3);
        if (lucky.length) this.say(this.pick(lucky)[0], 'bounty', {}, { chance: 0.4 });
        return;
      }
      case 'stolen': {
        if (isBot(e.victim)) this.say(e.victim, 'robbed', { thief: this.called(e.thief) }, { chance: 0.6, after: 400 });
        else if (isBot(e.thief)) this.say(e.thief, 'stole', { victim: this.called(e.victim) }, { chance: 0.45, after: 400 });
        return;
      }
      case 'monopoly': {
        const hit = Object.entries(e.taken).filter(([p, n]) => n > 0 && isBot(Number(p)));
        if (hit.length) this.say(Number(this.pick(hit)[0]), 'monopolyHit', { player: this.called(e.player) }, { chance: 0.6 });
        return;
      }
      case 'cityBuilt':
      case 'settlementBuilt': {
        if (!isBot(e.player)) return;
        // (Nearly there by this game's own target: 21 in a big mix, not the base game's 10.)
        const s = this.state();
        if (publicVictoryPoints(s, e.player) >= victoryTarget(s, e.player) - 2 && !this.nearlyThere.has(e.player)) {
          this.nearlyThere.add(e.player);
          this.say(e.player, 'close', {}, { chance: 0.7 });
          return;
        }
        this.say(e.player, e.type === 'cityBuilt' ? 'city' : 'settlement', {}, { chance: e.type === 'cityBuilt' ? 0.3 : 0.15 });
        return;
      }
      case 'longestRoadChanged': {
        if (isBot(e.to)) this.say(e.to, 'longest', {}, { chance: 0.6 });
        return;
      }
      case 'largestArmyChanged': {
        if (isBot(e.to)) this.say(e.to, 'army', {}, { chance: 0.6 });
        return;
      }
      case 'tradeOffered': {
        // A bot pitches its own offer to the table.
        const t = e.offer;
        if (isBot(t.proposer)) this.say(t.proposer, 'pitch', { give: describe(t.give), get: describe(t.get) }, { chance: 0.55, reply: true });
        return;
      }
      case 'tradeExecuted': {
        const bot = e.from === this.me ? e.to : e.to === this.me ? e.from : null;
        if (isBot(bot)) this.say(bot, 'traded', {}, { chance: 0.4 });
        return;
      }
      // The expansions' moments, from the seats they concern (all of them public).
      case 'sea/firstLanding':
        if (isBot(e.player)) this.say(e.player, 'landing', {}, { chance: 0.6 });
        return;
      case 'fleet/pillaged':
        if (isBot(e.player)) this.say(e.player, 'sacked', {}, { chance: 0.6, after: 400 });
        return;
      case 'invasion/battle': {
        const fought = e.participants.filter(isBot);
        if (e.conquered && fought.length) this.say(this.pick(fought), 'freed', {}, { chance: 0.5 });
        return;
      }
      case 'oil/flood':
      case 'oil/polluted':
        if (bots.length) this.say(this.pick(bots), 'disaster', {}, { chance: 0.35, after: 600 });
        return;
      case 'gameWon': {
        if (isBot(e.player)) this.say(e.player, 'won', {}, { reply: true });
        const losers = bots.filter((b) => b !== e.player);
        if (losers.length) this.say(this.pick(losers), e.player === this.me ? 'cheer' : 'lost', { winner: this.called(e.player) }, { reply: true, after: 1500 });
        return;
      }
    }
  }

  private yourTurn() {
    const s = this.state();
    return s.currentPlayer === this.me && s.phase === 'main' && !s.trade;
  }

  /**
   * The cheapest deal (for you) in which bot `b` gives you one `want`, that it would accept as
   * an offer: one card of something it values, else two. From your side: you give `give`, get `get`.
   */
  private dealFor(b: PlayerId, want: Resource): { give: CardCounts; get: CardCounts } | null {
    const s = this.state();
    if (!this.yourTurn() || this.known(b, want) < 1) return null;
    const profile = botProfile(this.difficulty(b), s.players[b].name);
    const mine = s.players[this.me].hand;
    const get = { ...emptyCards(), [want]: 1 };
    // Your most plentiful cards first, so the suggestion costs you what you can best spare.
    const yours = RESOURCES.filter((r) => r !== want && mine[r] > 0).sort((a, c) => mine[c] - mine[a]);
    const tries: CardCounts[] = [
      ...yours.map((r) => ({ ...emptyCards(), [r]: 1 })),
      ...yours.filter((r) => mine[r] >= 2).map((r) => ({ ...emptyCards(), [r]: 2 })),
      ...yours.flatMap((r, i) => yours.slice(i + 1).map((r2) => ({ ...emptyCards(), [r]: 1, [r2]: 1 }))),
    ];
    for (const give of tries) if (hasResources(mine, give) && wouldAccept(s, b, this.me, give, get, this.difficulty(b), profile)) return { give, get };
    return null;
  }

  /** How many `r` you can be sure bot `b` holds (from what happened at the table, not its hand). */
  private known(b: PlayerId, r: Resource) {
    return Math.floor(handEstimate(this.state(), this.me, b).sure[r] + 1e-9);
  }

  /** You said something: whoever you named answers (or someone does). */
  hear(text: string) {
    const bots = this.bots();
    if (!bots.length) return;
    const lower = text.toLowerCase();
    const named = bots.filter((b) => {
      // (Whole words, so a name's "ned" is not found in "planned".)
      const said = lower.split(/[^\p{L}\p{N}]+/u);
      return this.state().players[b].name.toLowerCase().split(' ').some((w) => w.length > 2 && said.includes(w));
    });
    const who = named.length ? named : [this.pick(bots)];
    const asked = RESOURCES.find((r) => RESOURCE_WORDS[r].test(lower));
    who.forEach((b, i) => {
      const after = i * 900;
      // A question about trading comes first: they answer from what you can know they hold (keeping a couple back).
      if (asked && /\b(trade|have|need|want|spare|swap|offer|any|anyone|sell|buy|got)\b/.test(lower)) {
        // On your turn, a deal it would really take; otherwise what it holds.
        const deal = this.dealFor(b, asked);
        if (deal) return this.say(b, 'deal', { get: describe(deal.get), give: describe(deal.give) }, { reply: true, after, offer: deal });
        const has = this.known(b, asked) >= 2;
        return this.say(b, has && !this.yourTurn() ? 'trade' : 'tradeNo', { r: CARD_NAMES[asked].toLowerCase() }, { reply: true, after });
      }
      if (/\b(robber|thief|steal|stole)\b/.test(lower)) return this.say(b, 'robberAsk', {}, { reply: true, after });
      if (/\b(good luck|gl|luck)\b/.test(lower)) return this.say(b, 'luck', {}, { reply: true, after });
      if (/\b(nice|well played|wp|gg|good game|great|thanks|thank you|ty|congrats|congratulations)\b/.test(lower)) return this.say(b, 'thanks', {}, { reply: true, after });
      if (/\b(hi|hello|hey|ahoy|greetings|morning|evening|howdy)\b/.test(lower)) return this.say(b, 'hello', {}, { reply: true, after });
      this.say(b, 'generic', {}, { reply: true, after, chance: named.length ? 1 : 0.6 });
    });
  }

}

/** Cards in words, for a line: "2 wool and 1 ore". */
function describe(rc: CardCounts) {
  const parts = RESOURCES.filter((r) => rc[r] > 0).map((r) => `${rc[r]} ${CARD_NAMES[r].toLowerCase()}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}
