// Who you are online. Nobody signs up to play: the first online step makes a guest identity
// (POST /api/guest), kept in this device's storage as the server's bearer token. The face you
// show (name, colour, avatar) is the one already chosen for singleplayer, so a returning player
// comes aboard as themselves; a first-time visitor still called "You" gets a sailor's name to
// keep or change.

import { NAME_MAX, type Identity } from '../net/protocol';
import { AVATARS } from '../game/names';
import { createGuest } from './api';
import { ownSailor, tabStorage } from './tabs';

/** The guest (or account) token and its public id. The token is a secret: storage only, never a URL or a log. */
const IDENTITY_KEY = 'exploratory.online.identity';
/** The singleplayer page's own keys (see ui/App.tsx): the name, and the set-up with the colour and avatar. */
const NAME_KEY = 'exploratory.name';
const SETUP_KEY = 'exploratory.setup';

/** The storage these read and write (a test passes its own). */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): KeyStore | null {
  // (A tab playing as a sailor of its own keeps its identity and face to itself: see tabs.ts.)
  if (ownSailor()) return tabStorage();
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // (Storage refused: a private window, or site data blocked.)
    return null;
  }
}

function read(store: KeyStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: KeyStore | null, key: string, value: string | null): boolean {
  try {
    if (!store) return false;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
    return true;
  } catch {
    /* (full, or refused: the identity lasts this visit) */
    return false;
  }
}

/** The identity of this visit when storage refuses it (blocked, or full), so one visit is one guest, not one per step. Per store. */
const memory = new WeakMap<object, Identity>();
let memoryNoStore: Identity | null = null;
const remembered = (store: KeyStore | null) => (store ? memory.get(store) ?? null : memoryNoStore);
function remember(store: KeyStore | null, id: Identity | null) {
  if (!store) memoryNoStore = id;
  else if (id) memory.set(store, id);
  else memory.delete(store);
}

/** The identity kept on this device, if a sound one is. */
export function loadIdentity(store = storage()): Identity | null {
  try {
    const v = JSON.parse(read(store, IDENTITY_KEY) ?? 'null') as Partial<Identity> | null;
    if (!v || typeof v.user !== 'string' || typeof v.token !== 'string' || !v.user || !v.token) return remembered(store);
    return { user: v.user, token: v.token, name: typeof v.name === 'string' ? v.name : '', guest: v.guest !== false, ...(typeof v.handle === 'string' && { handle: v.handle }) };
  } catch {
    return remembered(store);
  }
}

export function saveIdentity(id: Identity, store = storage()) {
  // (Kept in memory only when storage wouldn't take it.)
  remember(store, write(store, IDENTITY_KEY, JSON.stringify(id)) ? null : id);
}

/** Forget the identity (the server refused its token): the next online step makes a new one. */
export function forgetIdentity(store = storage()) {
  remember(store, null);
  write(store, IDENTITY_KEY, null);
}

/** The face shown at a table. */
export interface Profile {
  name: string;
  /** A preset colour's id, or #rrggbb. */
  color: string;
  /** An avatar code (ui/Avatar.tsx): -1 your initial, 0 and up the crew's portraits, -2 to -5 the crests. */
  avatar: number;
}

const okColor = (c: unknown): c is string => typeof c === 'string' && (/^[a-z]{3,12}$/.test(c) || /^#[0-9a-f]{6}$/i.test(c));
const okAvatar = (a: unknown): a is number => Number.isInteger(a) && (a as number) >= -5 && (a as number) < AVATARS.length;

/** A name as a table shows it: trimmed, its spaces single, no longer than the server allows. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** The singleplayer page's choices, as the face shown online. */
export function loadProfile(store = storage(), rand = Math.random): Profile {
  let setup: { color?: unknown; avatar?: unknown } = {};
  try {
    setup = (JSON.parse(read(store, SETUP_KEY) ?? '{}') as typeof setup) ?? {};
  } catch {
    /* (a set-up from an older version: the defaults) */
  }
  const name = cleanName(read(store, NAME_KEY) ?? '');
  return {
    // (The default "You" is no name to show others.)
    name: name && name.toLowerCase() !== 'you' ? name : sailorName(rand),
    color: okColor(setup.color) ? setup.color : 'red',
    avatar: okAvatar(setup.avatar) ? setup.avatar : -1,
  };
}

/** Keep a changed face for next time, in the singleplayer page's own keys (it reads them as its choices too). */
export function saveProfile(p: Profile, store = storage()) {
  write(store, NAME_KEY, cleanName(p.name));
  let setup: Record<string, unknown> = {};
  try {
    const v = JSON.parse(read(store, SETUP_KEY) ?? '{}') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) setup = v as Record<string, unknown>;
  } catch {
    /* (start the set-up over) */
  }
  write(store, SETUP_KEY, JSON.stringify({ ...setup, color: p.color, avatar: p.avatar }));
}

const HUES = ['Amber', 'Teal', 'Coral', 'Slate', 'Saffron', 'Indigo', 'Sorrel', 'Pearl', 'Russet', 'Jade', 'Cobalt', 'Ochre', 'Heather', 'Copper'];
const BIRDS = ['Gannet', 'Cormorant', 'Petrel', 'Tern', 'Puffin', 'Shearwater', 'Kittiwake', 'Albatross', 'Plover', 'Curlew', 'Heron', 'Skua', 'Fulmar', 'Osprey'];

/** A sailor's name for someone who hasn't chosen one ("Amber Gannet"). */
export function sailorName(rand = Math.random): string {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length) % xs.length];
  return `${pick(HUES)} ${pick(BIRDS)}`;
}

/**
 * The identity to play with: the one kept here, or a new guest made for this name. `f` and
 * `store` are for tests.
 */
export async function ensureGuest(name: string, o: { f?: typeof fetch; base?: string; store?: KeyStore | null } = {}): Promise<Identity> {
  const store = o.store === undefined ? storage() : o.store;
  const kept = loadIdentity(store);
  if (kept) return kept;
  const made = await createGuest(cleanName(name) || sailorName(), { f: o.f, base: o.base });
  const id: Identity = { user: made.user, token: made.token, name: made.name, guest: true };
  saveIdentity(id, store);
  return id;
}
