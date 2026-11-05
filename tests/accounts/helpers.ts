// What the account tests share: a World (tests/server/harness.ts) with the HTTP API in front of it,
// requests from the site's own origin with a bearer token, and a software authenticator that makes
// passkeys and signs with them as a phone would (after tests/server-lib/webauthn.test.ts).

import type { FinishedGame, ServerEnv } from '../../server/core/ports';
import { handleApi, type HttpContext } from '../../server/http/router';
import { concat, rawToDerEcdsa, sha256, toBase64Url, utf8, fromBase64Url } from '../../server/lib/crypto';
import { FLAG_AT, FLAG_BE, FLAG_BS, FLAG_UP, FLAG_UV, encodeCbor, type CborInput, type CreationOptionsJSON, type RequestOptionsJSON } from '../../server/lib/webauthn';
import { ENV, World } from '../server/harness';

export const ORIGIN = 'http://localhost:5173';

export interface Api {
  world: World;
  ctx: HttpContext;
  /** A request to the API, from the site, as `token` when given. */
  call(method: string, path: string, o?: { token?: string | null; body?: unknown; headers?: Record<string, string>; raw?: string }): Promise<Response>;
  /** The same, its JSON (and status). */
  json<T = any>(method: string, path: string, o?: { token?: string | null; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: T }>;
}

export async function api(seed = 1, env: Partial<ServerEnv> = {}): Promise<Api> {
  const world = await new World(seed).init();
  const ctx: HttpContext = {
    env: { ...ENV, ...env },
    db: world.db,
    blobs: world.blobs,
    services: world.services,
    rooms: { fetch: (c, p, i) => world.fetch(c, p, i) },
    now: () => world.now,
    random: (n) => world.random(n),
    ip: `10.1.${seed % 250}.${Math.floor(seed / 250) % 250}`,
  };
  const call: Api['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    return (await handleApi(new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: 'manual' }), ctx))!;
  };
  return {
    world,
    ctx,
    call,
    async json(method, path, o) {
      const r = await call(method, path, o);
      return { status: r.status, body: await r.json() };
    },
  };
}

/** A new guest's token and id, through the API. */
export async function guest(a: Api, name: string) {
  const r = await a.json<{ user: string; token: string; name: string }>('POST', '/api/guest', { body: { name } });
  if (r.status !== 201) throw new Error(`no guest: ${r.status}`);
  return r.body;
}

/** A finished game with these people (by user id) in the first seats and the crew in the rest. */
export async function finish(a: Api, people: { user: string; name: string }[], winner = 0, at = a.world.now): Promise<string> {
  const seats: FinishedGame['seats'] = [0, 1, 2, 3].map((seat) =>
    people[seat] ? { seat, user: people[seat].user, name: people[seat].name, color: 'red', bot: false } : { seat, name: `Crew ${seat}`, color: 'blue', bot: true, difficulty: 'normal' },
  );
  const out = await a.world.services.finishGame({
    room: 'BCDFGH', options: {}, seats, log: [], key: 'ab'.repeat(32), nonces: [null, null, null, null], winner,
    points: [10, 7, 5, 4], turns: 40, startedAt: at - 3_600_000, endedAt: at, rated: false,
  });
  return out.replay;
}

/** A passkey on a software authenticator: ES256, discoverable, with user verification. */
export class SoftPasskey {
  credentialId = crypto.getRandomValues(new Uint8Array(32));
  counter = 0;
  userHandle = '';
  private keys!: CryptoKeyPair;
  constructor(readonly origin = ORIGIN, readonly synced = true) {}

  private header(rpIdHash: Uint8Array, flags: number, counter: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(37);
    out.set(rpIdHash);
    out[32] = flags;
    new DataView(out.buffer).setUint32(33, counter);
    return out;
  }

  private get flags() {
    return FLAG_UP | FLAG_UV | (this.synced ? FLAG_BE | FLAG_BS : 0);
  }

  async create(options: CreationOptionsJSON) {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    this.userHandle = options.user.id;
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const cose = encodeCbor(new Map<CborInput, CborInput>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64Url(jwk.x!)], [-3, fromBase64Url(jwk.y!)]]));
    const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const authData = concat(
      this.header(await sha256(options.rp.id), this.flags | FLAG_AT, this.counter),
      new Uint8Array(16),
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      cose,
    );
    const attestationObject = encodeCbor(new Map<CborInput, CborInput>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const id = toBase64Url(this.credentialId);
    return { id, rawId: id, type: 'public-key', response: { clientDataJSON: toBase64Url(clientDataJSON), attestationObject: toBase64Url(attestationObject), transports: ['internal', 'hybrid'] } };
  }

  async get(options: RequestOptionsJSON, o: { challenge?: string } = {}) {
    // (A synced passkey keeps its counter at zero; this one counts, as a security key would.)
    this.counter++;
    const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge ?? options.challenge, origin: this.origin, crossOrigin: false }));
    const authData = this.header(await sha256(options.rpId), this.flags, this.counter);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, concat(authData, await sha256(clientDataJSON))));
    const id = toBase64Url(this.credentialId);
    return { id, rawId: id, type: 'public-key', response: { clientDataJSON: toBase64Url(clientDataJSON), authenticatorData: toBase64Url(authData), signature: toBase64Url(rawToDerEcdsa(sig)), userHandle: this.userHandle } };
  }
}

/** Register a passkey for this token's guest (or account) through the routes; the sign-in's answer. */
export async function addPasskey(a: Api, token: string, key = new SoftPasskey(), settings?: { birthYear?: number; chat?: 'quick' | 'free' }) {
  const opts = await a.json<{ options: CreationOptionsJSON; flow: string }>('POST', '/api/auth/passkey/register/options', { token });
  if (opts.status !== 200) throw new Error(`register options: ${opts.status}`);
  const response = await key.create(opts.body.options);
  const r = await a.json('POST', '/api/auth/passkey/register/verify', { token, body: { flow: opts.body.flow, response, ...(settings && { settings }) } });
  return { ...r, key, options: opts.body.options };
}

/** Sign in with a passkey through the routes (as `token`'s guest, when given). */
export async function signInWith(a: Api, key: SoftPasskey, token?: string) {
  const opts = await a.json<{ options: RequestOptionsJSON; flow: string }>('POST', '/api/auth/passkey/login/options', { token });
  const response = await key.get(opts.body.options);
  return a.json('POST', '/api/auth/passkey/login/verify', { token, body: { flow: opts.body.flow, response } });
}

/** A guest made into an account with a passkey: its id, new token and handle. */
export async function account(a: Api, name: string, settings?: { birthYear?: number; chat?: 'quick' | 'free' }) {
  const g = await guest(a, name);
  const r = await addPasskey(a, g.token, new SoftPasskey(), settings);
  if (r.status !== 201) throw new Error(`no account: ${r.status} ${JSON.stringify(r.body)}`);
  return { user: r.body.user as string, token: r.body.token as string, handle: r.body.handle as string, name: r.body.name as string, guestToken: g.token, key: r.key };
}
