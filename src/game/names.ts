import type { Card, DevCardType, Terrain, Track } from '../engine';
import type { BotPersonality } from '../engine/ai/profiles';
import type { VentureId } from '../engine/modules/guilds/types';
import type { Happening } from '../engine/modules/almanac/types';
import type { MusterCard } from '../engine/modules/invasion/types';

/** Every kind of hex, as players call it (a hex's name as the table sees it, fishing grounds and the fog included, is game/hexView.ts's). */
export const TERRAIN_NAMES: Record<Terrain, string> = {
  hills: 'Hills',
  forest: 'Forest',
  pasture: 'Pasture',
  fields: 'Fields',
  mountains: 'Mountains',
  desert: 'Desert',
  bounty: 'Bounty field',
  swamp: 'Swamp',
  lake: 'Lake',
  oasis: 'Oasis',
  castle: 'Castle',
  sea: 'Sea',
};

/** Names of every kind of card: the resources, Guilds' commodities and oil. */
export const CARD_NAMES: Record<Card, string> = {
  brick: 'Brick',
  wood: 'Wood',
  wool: 'Wool',
  wheat: 'Wheat',
  ore: 'Ore',
  paper: 'Paper',
  cloth: 'Cloth',
  silver: 'Silver',
  oil: 'Oil',
};

/** Card icons: the resources, the guilds' commodities and oil, each one painted object. */
export const CARD_ICON: Record<Card, string> = {
  brick: 'art/icons/brick.webp',
  wood: 'art/icons/wood.webp',
  wool: 'art/icons/wool.webp',
  wheat: 'art/icons/wheat.webp',
  ore: 'art/icons/ore.webp',
  paper: 'art/icons/paper.webp',
  cloth: 'art/icons/cloth.webp',
  silver: 'art/icons/silver.webp',
  oil: 'art/icons/oil.webp',
};

/**
 * The expansions' tokens, painted like the resource icons: coins (rivers, the invasion), fish and
 * the Soggy Boot (fisheries), wardens, prisoners (the invasion), the fleet's defence token, and the
 * rivers' Richest and Pauper tiles (the paintings in AWARD_ART are for the banner instead).
 */
export const TOKEN_ICON = {
  coin: 'art/icons/coin.webp',
  fish: 'art/icons/fish.webp',
  boot: 'art/icons/boot.webp',
  warden: 'art/icons/warden.webp',
  prisoner: 'art/icons/prisoner.webp',
  defence: 'art/icons/defence.webp',
  richest: 'art/icons/richest.webp',
  pauper: 'art/icons/pauper.webp',
} as const;

/** Each guild track's emblem: an open book, a merchant's purse, a crown. */
export const TRACK_ICON: Record<Track, string> = {
  learning: 'art/icons/learning.webp',
  commerce: 'art/icons/commerce.webp',
  statecraft: 'art/icons/statecraft.webp',
};

/** Painted UI icons, same gouache style as the resource icons. */
export const UI_ICON = {
  road: 'art/icons/road.webp',
  settlement: 'art/icons/settlement.webp',
  city: 'art/icons/city.webp',
  devcard: 'art/icons/devcard.webp',
  knight: 'art/icons/knight.webp',
  route: 'art/icons/route.webp',
  trade: 'art/icons/trade.webp',
  harbour: 'art/icons/harbour.webp',
  vp: 'art/icons/vp.webp',
  cards: 'art/icons/cards.webp',
  dice: 'art/icons/dice.webp',
  // (The expansions' builds, beside the road, settlement and city on the build bar.)
  ship: 'art/icons/ship.webp',
  bridge: 'art/icons/bridge.webp',
  wall: 'art/icons/wall.webp',
  foundry: 'art/icons/foundry.webp',
} as const;
export type UiIconName = keyof typeof UI_ICON;

export const CARD_TINT: Record<Card, string> = {
  brick: '#b5532f',
  wood: '#3f7a35',
  wool: '#86b84f',
  wheat: '#d9a933',
  ore: '#6f7d8f',
  // (Paper was the parchment colour itself, so its card had no colour of its own. It takes an ink
  // blue from the learning guild's family, the track it buys; the guild's own slate sat too close
  // to ore's grey in the hand, where only the rings and the medallion carry the tint.)
  paper: '#2f6aa0',
  cloth: '#a8437a',
  silver: '#b9c2cc',
  oil: '#2b2622',
};

export const DEV_NAMES: Record<DevCardType, string> = {
  knight: 'Knight',
  roadBuilding: 'Road Crew',
  invention: 'Invention',
  monopoly: 'Hoarder',
  victoryPoint: 'Victory Point',
};

export const DEV_TEXT: Record<DevCardType, string> = {
  knight: 'Move the robber, steal 1 card',
  roadBuilding: 'Build 2 free roads',
  invention: 'Take 2 from the supply',
  monopoly: 'Take every card of 1 type',
  victoryPoint: '+1 Victory Point',
};

/** Victory Point cards take their art from VP_VARIANTS instead. */
export const DEV_ART: Record<Exclude<DevCardType, 'victoryPoint'>, string> = {
  knight: 'art/cards/knight.webp',
  roadBuilding: 'art/cards/roadBuilding.webp',
  invention: 'art/cards/invention.webp',
  monopoly: 'art/cards/monopoly.webp',
};

export const VP_VARIANTS = [
  { art: 'art/cards/vp_chapel.webp', name: 'Bell Chapel' },
  { art: 'art/cards/vp_library.webp', name: 'Reading Room' },
  { art: 'art/cards/vp_market.webp', name: 'Fair Square' },
  { art: 'art/cards/vp_greatHall.webp', name: 'Lion Hall' },
  { art: 'art/cards/vp_university.webp', name: 'Observatory' },
];

/**
 * A painting for every venture, portrait like the development cards. (A Record, so a new venture
 * is a compile error here until it has art; tests/art.test.ts checks each file is there.)
 */
const BORROWED_VENTURE_ART: Record<VentureId, string> = {
  augury: 'art/ventures/augury.webp',
  hoist: 'art/ventures/hoist.webp',
  masonry: 'art/ventures/masonry.webp',
  resurvey: 'art/ventures/resurvey.webp',
  waterworks: 'art/ventures/waterworks.webp',
  townPlanning: 'art/ventures/townPlanning.webp',
  deepSeams: 'art/ventures/deepSeams.webp',
  pathfinders: 'art/ventures/pathfinders.webp',
  forge: 'art/ventures/forge.webp',
  encyclopaedia: 'art/ventures/encyclopaedia.webp',
  barter: 'art/ventures/barter.webp',
  tribute: 'art/ventures/tribute.webp',
  trader: 'art/ventures/trader.webp',
  charterFleet: 'art/ventures/charterFleet.webp',
  cornerMarket: 'art/ventures/cornerMarket.webp',
  cartel: 'art/ventures/cartel.webp',
  // (New ventures borrow the retired cards' paintings until they have their own.)
  salvage: 'art/ventures/deepSeams.webp',
  pilot: 'art/ventures/pathfinders.webp',
  tradeWind: 'art/ventures/charterFleet.webp',
  customs: 'art/ventures/cartel.webp',
  stockpile: 'art/ventures/cornerMarket.webp',
  lighthouse: 'art/ventures/masonry.webp',
  rightOfWay: 'art/ventures/rightOfWay.webp',
  rally: 'art/ventures/rally.webp',
  spymaster: 'art/ventures/spymaster.webp',
  agitators: 'art/ventures/agitators.webp',
  unrest: 'art/ventures/unrest.webp',
  taxCollectors: 'art/ventures/taxCollectors.webp',
  treachery: 'art/ventures/treachery.webp',
  grandCharter: 'art/ventures/grandCharter.webp',
  dowry: 'art/ventures/dowry.webp',
};

/**
 * Ventures whose own painting (art/ventures/<id>.webp) is in public/. Paint the six newest cards
 * with scripts/art/gen_art.py (see its header), then add their ids here:
 * ['salvage', 'pilot', 'tradeWind', 'customs', 'stockpile', 'lighthouse']. Until then they borrow above.
 */
export const OWN_VENTURE_ART: readonly VentureId[] = ['salvage', 'pilot', 'tradeWind', 'customs', 'stockpile', 'lighthouse'];

export const VENTURE_ART = Object.fromEntries(
  Object.entries(BORROWED_VENTURE_ART).map(([id, p]) => [id, OWN_VENTURE_ART.includes(id as VentureId) ? `art/ventures/${id}.webp` : p]),
) as Record<VentureId, string>;

/** The invasion's muster cards, portrait like the ventures. */
export const MUSTER_ART: Record<MusterCard, string> = {
  levy: 'art/muster/levy.webp',
  outrider: 'art/muster/outrider.webp',
  ambush: 'art/muster/ambush.webp',
  turncoat: 'art/muster/turncoat.webp',
};

/** A painting for each of the Almanac's happenings, square (its card is shown small beside the roll). */
export const HAPPENING_ART: Record<Happening, string> = {
  fairDay: 'art/happenings/fairDay.webp',
  calmSeas: 'art/happenings/calmSeas.webp',
  quarrel: 'art/happenings/quarrel.webp',
  quake: 'art/happenings/quake.webp',
  sickness: 'art/happenings/sickness.webp',
  gifts: 'art/happenings/gifts.webp',
  helpingHand: 'art/happenings/helpingHand.webp',
  harvest: 'art/happenings/harvest.webp',
  robberFlees: 'art/happenings/robberFlees.webp',
  tournament: 'art/happenings/tournament.webp',
  windfall: 'art/happenings/windfall.webp',
  thieves: 'art/happenings/thieves.webp',
};

/**
 * The expansions' awards and tiles, square like the two base awards: each told with a banner when
 * it changes hands (the first landing is the sea's island points, the defence the fleet's token).
 */
export const AWARD_ART = {
  harbourmaster: 'art/awards/harbourmaster.webp',
  steward: 'art/awards/steward.webp',
  richest: 'art/awards/richest.webp',
  pauper: 'art/awards/pauper.webp',
  defence: 'art/awards/defender.webp',
  firstLanding: 'art/awards/firstLanding.webp',
} as const;

/** Each guild track's seat, the award for climbing it furthest. */
export const SEAT_ART: Record<Track, string> = {
  learning: 'art/awards/seat_learning.webp',
  commerce: 'art/awards/seat_commerce.webp',
  statecraft: 'art/awards/seat_statecraft.webp',
};

/**
 * The painted portraits, in avatar-code order (code 0 is the first). To add more: paint them with
 * scripts/art/gen_art.py (avatar_5 and on), put the optimised files beside these and list them
 * here; nothing else counts them. The crew names below that wait on a portrait of their own
 * (`later`) take it as soon as it is listed.
 */
export const AVATARS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => `art/avatars/${i}.webp`),
];

/**
 * One member of the crew the computer players are drawn from. `voice` is the character that
 * plays and talks like them (game/host.ts personalityOf, game/tableTalk.ts); `face` the portrait
 * (an index into AVATARS) that suits their name, age and manner. `later` is the portrait painted
 * for this name alone (avatar_5 to avatar_12 in scripts/art/gen_art.py, so index 4 to 11): it is
 * worn once AVATARS lists it, and until then `face` stands in.
 */
interface CrewMember {
  name: string;
  voice: BotPersonality;
  face: number;
  later?: number;
}

/**
 * The crew, in the order names were given: the four the game began with come first, and a saved
 * game or an online room names them as it did (never reorder or rename these; add to the end).
 * Each portrait's names fit it: an old sea captain (the traders), a young woman cartographer
 * (the settlers), a broad, cheerful smith (the smiths) and a spectacled elder scholar (the
 * scholars). Titles (Captain, Bosun, Elder, Master) are used once each, so that "Captain, any
 * wheat?" at the table is plain to whom it is said.
 */
const CREW: readonly CrewMember[] = [
  { name: 'Captain Bramble', voice: 'trader', face: 0 },
  { name: 'Wren Ashdown', voice: 'settler', face: 1 },
  { name: 'Tobias Forge', voice: 'smith', face: 2 },
  { name: 'Elder Quill', voice: 'scholar', face: 3 },
  { name: 'Bosun Pellow', voice: 'trader', face: 0 },
  { name: 'Marisol Venn', voice: 'settler', face: 1 },
  { name: 'Baptiste Harrow', voice: 'smith', face: 2 },
  { name: 'Master Ambrose', voice: 'scholar', face: 3 },
  { name: 'Tomas Halvorsen', voice: 'trader', face: 0, later: 4 },
  { name: 'Ned Fairweather', voice: 'trader', face: 0, later: 5 },
  { name: 'Imani Birch', voice: 'settler', face: 1, later: 6 },
  { name: 'Nilufar Reed', voice: 'settler', face: 1, later: 7 },
  { name: 'Kofi Brasswright', voice: 'smith', face: 2, later: 8 },
  { name: 'Gunnar Stokes', voice: 'smith', face: 2, later: 9 },
  { name: 'Rahim Thorley', voice: 'scholar', face: 3, later: 10 },
  { name: 'Isidore Fenn', voice: 'scholar', face: 3, later: 11 },
];

/** Every name a computer player can be given. */
export const BOT_NAMES: readonly string[] = CREW.map((c) => c.name);

const crewNamed = (name: string) => CREW.find((c) => c.name === name);

/** The portrait (an avatar code) that goes with a crew member's name; -1 for a name that isn't theirs. */
export function avatarOf(name: string): number {
  const c = crewNamed(name);
  if (!c) return -1;
  return c.later !== undefined && AVATARS[c.later] ? c.later : c.face;
}

/** The character that goes with a crew member's name, if it is one. */
export function voiceOf(name: string): BotPersonality | undefined {
  return crewNamed(name)?.voice;
}

/**
 * `count` crew for a table, none repeated: names at random from `random` (so a seeded stream gives
 * the same crew every time). They are chosen to look and sound different from one another: each
 * with a portrait nobody else at the table wears (`faces`, the people's, are already worn) and
 * if there are voices enough, a voice of its own. `taken` names are never chosen, and the voices
 * and portraits of those seated already count as used. Fewer than `count` come back only when the
 * crew runs out.
 */
export function pickCrew(count: number, random: () => number, o: { taken?: Iterable<string>; faces?: Iterable<number> } = {}): string[] {
  const taken = new Set(o.taken ?? []);
  const faces = new Set(o.faces ?? []);
  const voices = new Set<BotPersonality>();
  for (const name of taken) {
    const c = crewNamed(name);
    if (c) {
      faces.add(avatarOf(name));
      voices.add(c.voice);
    }
  }
  const pool = CREW.filter((c) => !taken.has(c.name));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: string[] = [];
  const take = (ok: (c: CrewMember) => boolean) => {
    for (const c of pool) {
      if (out.length >= count) return;
      if (out.includes(c.name) || !ok(c)) continue;
      out.push(c.name);
      faces.add(avatarOf(c.name));
      voices.add(c.voice);
    }
  };
  take((c) => !faces.has(avatarOf(c.name)) && !voices.has(c.voice));
  take((c) => !faces.has(avatarOf(c.name)));
  take(() => true);
  return out;
}

export const asset = (p: string) => `${import.meta.env.BASE_URL}${p}`;
