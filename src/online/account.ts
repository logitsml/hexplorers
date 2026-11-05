// Your account, from this client: keeping your progress (a passkey on this device, a provider, or a
// letter), signing in on another device, your profile, sessions, the copy of your logbook and
// erasing it, other people's profiles, friends, blocks and reports. An account is the guest you
// already were, upgraded: once signed in, the token kept in this device's storage is the account's
// session instead of the guest's (the same public id), and signing out comes back as a fresh guest.
// Tokens only ever go in the Authorization header; a provider's session comes back through an
// HttpOnly cookie the page picks up, a letter's through the link's #fragment.

import { create } from 'zustand';
import type { Identity, ReportReason } from '../net/protocol';
import { useUI } from '../game/store';
import { ApiError } from './api';
import { ensureGuest, forgetIdentity, loadIdentity, loadProfile, saveIdentity, saveProfile } from './identity';
import { useOnline } from './store';

// ------------------------------------------------------------------ what the server answers

export type AgeBand = 'u13' | '13-15' | '16-17' | '18+';
export type ProviderId = 'google' | 'apple' | 'discord';

export interface PlayRecord {
  replay: string;
  seat: number;
  points: number;
  won: boolean;
  at: number;
}

export interface Me {
  user: string;
  name: string;
  guest: boolean;
  handle?: string;
  avatar?: number;
  color?: string;
  created?: number;
  settings?: { ageBand: AgeBand | null; chat: 'quick' | 'free'; prefs: Record<string, unknown> };
  quickTalk?: boolean;
  methods?: { passkeys: { id: string; device: string; created: number; used: number | null; synced: boolean }[]; providers: ProviderId[]; email: { address: string | null; notify: boolean } | null };
  played: number;
  won: number;
  recent: PlayRecord[];
}

export interface PublicProfile {
  user: string;
  handle: string;
  name: string;
  avatar: number;
  color: string;
  joined: number;
  played: number;
  won: number;
  recent: PlayRecord[];
  rating?: unknown;
}

export interface Sailor {
  user: string;
  handle?: string;
  name: string;
  avatar?: number;
  color?: string;
  guest: boolean;
}

export interface FriendLists {
  friends: (Sailor & { since: number; lastSeen: number | null; where?: 'harbour' | 'playing' })[];
  incoming: (Sailor & { at: number })[];
  outgoing: (Sailor & { at: number })[];
  recent: (Sailor & { at: number })[];
}

export interface SessionInfo {
  id: string;
  device: string;
  created: number;
  lastSeen: number;
  current: boolean;
}

// ------------------------------------------------------------------ the store

export type SheetMode = 'keep' | 'signin';

export interface AccountStore {
  /** Who you are, as the server last said (null: not asked yet, or no server). */
  me: Me | null;
  /** The sign-in sheet, when open. */
  sheet: SheetMode | null;
  /** A profile being looked at (a /u/HANDLE link, or a seat's). */
  viewing: string | null;
  /** A word after coming back from a provider or a letter. */
  note: { text: string; bad?: boolean } | null;
  set: (p: Partial<AccountStore>) => void;
}

export const useAccount = create<AccountStore>((set) => ({ me: null, sheet: null, viewing: null, note: null, set }));

/** Whether this device signs in as an account (not a guest). */
export const signedIn = () => loadIdentity()?.guest === false;

/** This device's public id (a guest's or an account's), if it has one. */
export const myId = () => loadIdentity()?.user ?? null;

// ------------------------------------------------------------------ calls

type Fetch = typeof fetch;
let f: Fetch = (...a) => fetch(...a);
/** Tests answer from their own table. */
export function setFetch(x: Fetch) {
  f = x;
}

async function ask<T>(method: string, path: string, o: { body?: unknown; token?: string | null; anonymous?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const token = o.anonymous ? null : (o.token ?? loadIdentity()?.token ?? null);
  if (token) headers.authorization = `Bearer ${token}`;
  let r: Response;
  try {
    r = await f(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'The harbour can’t be reached. Check your connection and try again.');
  }
  let body: (T & { error?: string; code?: string }) | null = null;
  try {
    body = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : null;
  } catch {
    body = null;
  }
  if (!r.ok) throw new ApiError(r.status, body?.error ?? `The harbour answered ${r.status}`, body?.code);
  if (body === null) throw new ApiError(r.status, 'The harbour’s answer made no sense.');
  return body;
}

/** The identity to ask as: the one kept here, or a new guest (the page's name). */
async function identity(): Promise<Identity> {
  return loadIdentity() ?? ensureGuest(loadProfile().name);
}

/** What a sign-in answers. */
type SignedIn = { user: string; token: string; name: string; handle?: string };

/** A sign-in's answer becomes this device's identity: the account's session in the guest's place. */
async function adopt(id: SignedIn) {
  saveIdentity({ user: id.user, token: id.token, name: id.name, guest: false, ...(id.handle && { handle: id.handle }) });
  const me = await refresh();
  // (Signed in on another device: the account's name and colours are this device's from now on.)
  if (me && !me.guest && me.name) saveProfile({ name: me.name, color: me.color ?? loadProfile().color, avatar: me.avatar ?? loadProfile().avatar });
  sayWhere();
}

/** Ask the server who you are (a revoked session comes back as a fresh guest). */
export async function refresh(again = true): Promise<Me | null> {
  const id = loadIdentity();
  // (No identity yet: a guest is made at the first online step, not for looking at this page.)
  if (!id) {
    const me: Me = { user: '', name: loadProfile().name, guest: true, played: 0, won: 0, recent: [] };
    useAccount.getState().set({ me });
    return me;
  }
  try {
    const me = await ask<Me>('GET', '/api/me', { token: id.token });
    useAccount.getState().set({ me });
    // (The handle kept with the token follows a change made on another device.)
    if (!me.guest && (id.handle !== me.handle || id.name !== me.name)) saveIdentity({ ...id, name: me.name, handle: me.handle, guest: false });
    return me;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && again) {
      // (Signed out elsewhere, or erased: this device starts over as a guest.)
      forgetIdentity();
      useAccount.getState().set({ me: null });
      return refresh(false);
    }
    return null;
  }
}

// ------------------------------------------------------------------ passkeys

/** Whether this browser can make and use passkeys at all. */
export const passkeysHere = () => typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;

const B64 = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const b64 = (buf: ArrayBuffer | Uint8Array | null) => {
  if (!buf) return '';
  let s = '';
  for (const x of new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

type CreationJSON = { rp: { id: string; name: string }; user: { id: string; name: string; displayName: string }; challenge: string; excludeCredentials: { id: string; type: 'public-key'; transports?: string[] }[] } & Record<string, unknown>;
type RequestJSON = { rpId: string; challenge: string; allowCredentials: { id: string; type: 'public-key' }[] } & Record<string, unknown>;
type PKC = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
};

function creationOptions(o: CreationJSON): PublicKeyCredentialCreationOptions {
  const P = window.PublicKeyCredential as PKC;
  if (P.parseCreationOptionsFromJSON) return P.parseCreationOptionsFromJSON(o);
  return {
    ...(o as unknown as PublicKeyCredentialCreationOptions),
    challenge: B64(o.challenge),
    user: { ...o.user, id: B64(o.user.id) },
    excludeCredentials: o.excludeCredentials.map((c) => ({ ...c, id: B64(c.id), transports: c.transports as AuthenticatorTransport[] | undefined })),
  };
}

function requestOptions(o: RequestJSON): PublicKeyCredentialRequestOptions {
  const P = window.PublicKeyCredential as PKC;
  if (P.parseRequestOptionsFromJSON) return P.parseRequestOptionsFromJSON(o);
  return { ...(o as unknown as PublicKeyCredentialRequestOptions), challenge: B64(o.challenge), allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: B64(c.id) })) };
}

/** A credential as the server reads it (the browser's toJSON where there is one). */
function credentialJSON(c: PublicKeyCredential): unknown {
  const withJSON = c as PublicKeyCredential & { toJSON?: () => unknown };
  if (typeof withJSON.toJSON === 'function') return withJSON.toJSON();
  const r = c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const base = { id: c.id, rawId: b64(c.rawId), type: c.type };
  if ('attestationObject' in r && r.attestationObject) {
    return { ...base, response: { clientDataJSON: b64(r.clientDataJSON), attestationObject: b64(r.attestationObject), transports: typeof r.getTransports === 'function' ? r.getTransports() : [] } };
  }
  return { ...base, response: { clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature), userHandle: r.userHandle ? b64(r.userHandle) : null } };
}

/** Why a passkey didn't happen, in words (null: the person just closed the prompt). */
function passkeyTrouble(e: unknown): string | null {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  if (name === 'InvalidStateError') return 'This device has a passkey for your account already.';
  if (name === 'SecurityError') return 'Passkeys need this page on its own address (https, or localhost).';
  if (e instanceof ApiError) return e.message;
  return 'The passkey didn’t work here. Try again, or another way.';
}

export interface SignUp {
  birthYear?: number;
  chat?: 'quick' | 'free';
}

/**
 * Add a passkey: a guest keeps their progress as an account (the same id), an account adds this
 * device's. Returns null when done, or what went wrong in words ('' when the person cancelled).
 */
export async function addPasskey(signUp?: SignUp): Promise<string | null> {
  try {
    const id = await identity();
    const o = await ask<{ options: CreationJSON; flow: string }>('POST', '/api/auth/passkey/register/options', { token: id.token });
    const cred = (await navigator.credentials.create({ publicKey: creationOptions(o.options) })) as PublicKeyCredential | null;
    if (!cred) return '';
    const r = await ask<{ user: string; token: string; name: string; handle: string } | { added: true }>('POST', '/api/auth/passkey/register/verify', { token: id.token, body: { flow: o.flow, response: credentialJSON(cred), ...(signUp && id.guest && { settings: signUp }) } });
    if ('token' in r) await adopt(r);
    else await refresh();
    return null;
  } catch (e) {
    return passkeyTrouble(e) ?? '';
  }
}

/** Sign in with a passkey this device (or a phone nearby) has. */
export async function signInWithPasskey(): Promise<string | null> {
  try {
    const id = loadIdentity();
    const o = await ask<{ options: RequestJSON; flow: string }>('POST', '/api/auth/passkey/login/options', { anonymous: true });
    const cred = (await navigator.credentials.get({ publicKey: requestOptions(o.options) })) as PublicKeyCredential | null;
    if (!cred) return '';
    // (As this device's guest, so the games played here come along.)
    await adopt(await ask<SignedIn>('POST', '/api/auth/passkey/login/verify', { token: id?.guest ? id.token : null, anonymous: !id?.guest, body: { flow: o.flow, response: credentialJSON(cred) } }));
    return null;
  } catch (e) {
    return passkeyTrouble(e) ?? '';
  }
}

// ------------------------------------------------------------------ providers and letters

const SIGNUP_KEY = 'exploratory.online.signup';

/** Off to a provider (the page leaves; it comes back to the Multiplayer page with #signin). */
export async function signInWith(provider: ProviderId, signUp?: SignUp): Promise<string | null> {
  try {
    const id = await identity();
    const { url } = await ask<{ url: string }>('POST', `/api/auth/oauth/${provider}/start`, { token: id.token });
    try {
      if (signUp && id.guest) sessionStorage.setItem(SIGNUP_KEY, JSON.stringify(signUp));
    } catch {
      /* (the birth year can be given afterwards) */
    }
    location.assign(url);
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'That way in isn’t answering. Try another.';
  }
}

/** Send a sign-in letter (a link and a code); `notify`: keep the address for "your move" letters too. */
export async function sendLetter(email: string, notify: boolean): Promise<string | null> {
  try {
    const id = await identity();
    await ask('POST', '/api/auth/email/start', { token: id.token, body: { email: email.trim(), notify } });
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'The letter couldn’t be sent.';
  }
}

/** The letter's code, typed in on this device. */
export async function enterCode(email: string, code: string, signUp?: SignUp): Promise<string | null> {
  try {
    const id = await identity();
    await adopt(await ask<SignedIn>('POST', '/api/auth/email/verify', { token: id.token, body: { email: email.trim(), code: code.replace(/\D/g, ''), ...(signUp && id.guest && { settings: signUp }) } }));
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'That code didn’t work.';
  }
}

/**
 * Back from a provider (#signin) or a letter's link (#magic=…): pick up the session, then tidy the
 * address. Called as the account section opens.
 */
export async function pickUpSignIn(): Promise<void> {
  const hash = typeof location === 'undefined' ? '' : location.hash;
  if (!/^#(signin|signin-failed|magic=)/.test(hash)) return;
  try {
    history.replaceState(history.state, '', location.pathname + location.search);
  } catch {
    /* (a sandboxed frame) */
  }
  const s = useAccount.getState();
  if (hash === '#signin-failed') return s.set({ note: { text: 'That sign-in didn’t go through. Try again, or another way.', bad: true } });
  try {
    if (hash === '#signin') {
      await adopt(await ask<SignedIn>('POST', '/api/auth/claim', { anonymous: true }));
      let pending: SignUp | null = null;
      try {
        pending = JSON.parse(sessionStorage.getItem(SIGNUP_KEY) ?? 'null') as SignUp | null;
        sessionStorage.removeItem(SIGNUP_KEY);
      } catch {
        /* (none) */
      }
      if (pending?.birthYear) await saveMe({ settings: { birthYear: pending.birthYear, ...(pending.chat && { chat: pending.chat }) } }).catch(() => undefined);
    } else {
      const token = decodeURIComponent(hash.slice('#magic='.length));
      const id = await identity();
      await adopt(await ask<SignedIn>('POST', '/api/auth/email/verify', { token: id.token, body: { token } }));
    }
    s.set({ note: { text: 'You’re signed in: your logbook is safe.' } });
  } catch (e) {
    s.set({ note: { text: e instanceof ApiError ? e.message : 'That sign-in didn’t go through.', bad: true } });
  }
}

// ------------------------------------------------------------------ your account

export interface MePatch {
  name?: string;
  handle?: string;
  avatar?: number;
  color?: string;
  settings?: { birthYear?: number; chat?: 'quick' | 'free'; prefs?: Record<string, unknown> };
}

/** Change your profile; the server's word on it (an ApiError says what it refused). */
export async function saveMe(patch: MePatch): Promise<Me> {
  const id = await identity();
  const me = await ask<Me>('PATCH', '/api/me', { token: id.token, body: patch });
  if (!me.guest) {
    saveIdentity({ ...id, name: me.name, handle: me.handle, guest: false });
    // (A patch answers with the profile, not the record: keep the one we had.)
    const was = useAccount.getState().me;
    useAccount.getState().set({ me: { ...me, played: me.played ?? was?.played ?? 0, won: me.won ?? was?.won ?? 0, recent: me.recent ?? was?.recent ?? [] } });
  } else useAccount.getState().set({ me: { ...(useAccount.getState().me ?? me), name: me.name } });
  return me;
}

export const sessions = async () => (await ask<{ sessions: SessionInfo[] }>('GET', '/api/auth/sessions')).sessions;
export const revokeSession = (id: string) => ask('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`);

/** Sign out: this session ends, and this device is a fresh guest (the name and colours stay). */
export async function signOut() {
  await ask('POST', '/api/auth/logout').catch(() => undefined);
  forgetIdentity();
  useAccount.getState().set({ me: null });
  await refresh();
}

/** "Copy of my logbook": everything kept about you, as a file. */
export async function downloadLogbook(): Promise<string | null> {
  try {
    const data = await ask<unknown>('GET', '/api/me/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'exploratory-logbook.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'The copy couldn’t be made.';
  }
}

/** "Strike from the register": erased, and this device starts over as a guest. */
export async function eraseMe(confirm: string): Promise<string | null> {
  try {
    await ask('DELETE', '/api/me', { body: { confirm } });
    forgetIdentity();
    useAccount.getState().set({ me: null });
    await refresh();
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'That didn’t go through.';
  }
}

// ------------------------------------------------------------------ other people

export const profile = (handle: string) => ask<PublicProfile>('GET', `/api/u/${encodeURIComponent(handle.replace(/^@/, ''))}`);

/** Open someone's profile over the Multiplayer page (a /u/HANDLE link). */
export function showProfile(handle: string) {
  useAccount.getState().set({ viewing: handle });
  if (useUI.getState().screen === 'title') useUI.getState().set({ goPage: { page: 'multi' } });
}

export const friendLists = () => ask<FriendLists>('GET', '/api/friends');
export const askFriend = (who: { handle: string } | { user: string }) => ask<{ state: 'asked' | 'friends' }>('POST', '/api/friends', { body: who });
export const acceptFriend = (user: string) => ask('POST', `/api/friends/${encodeURIComponent(user)}/accept`);
export const declineFriend = (user: string) => ask('POST', `/api/friends/${encodeURIComponent(user)}/decline`);
export const removeFriend = (user: string) => ask('DELETE', `/api/friends/${encodeURIComponent(user)}`);
export const inviteFriend = (user: string, code: string) => ask('POST', `/api/friends/${encodeURIComponent(user)}/invite`, { body: { code } });

export const blockList = async () => (await ask<{ blocked: Sailor[] }>('GET', '/api/block')).blocked;
export const block = (who: { user: string } | { handle: string }) => ask('POST', '/api/block', { body: who });
export const unblock = (user: string) => ask('DELETE', `/api/block/${encodeURIComponent(user)}`);

/** A report about someone: from a seat in this room through the room (which adds the chat), else from their profile. */
export async function report(about: { user?: string; handle?: string; seat?: number }, reason: ReportReason, note?: string) {
  const room = (await import('../app/session')).session.room;
  if (about.seat !== undefined && room) {
    if (room.send({ t: 'report', seat: about.seat, reason, ...(note && { note }) })) return;
  }
  await ask('POST', '/api/report', { body: { ...(about.user ? { user: about.user } : { handle: about.handle }), reason, ...(note && { note }) } });
}

// ------------------------------------------------------------------ where you are, for your friends

let told: string | null | undefined;

/** Tell the server which room you're in (an account's friends see "In a harbour" or "At sea"). */
export function sayWhere() {
  const code = useOnline.getState().code;
  if (!signedIn() || code === told) return;
  told = code;
  void ask('PUT', '/api/friends/here', { body: { code } }).catch(() => (told = undefined));
}

// (From the moment anything here is loaded: the harbour loads it with its seat menus.)
useOnline.subscribe((s, p) => {
  if (s.code !== p.code) sayWhere();
});
