import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeJwt, signJwt, toBase64, verifyJwtSignature } from '../../server/lib/crypto';
import {
  JwksCache,
  OAuthError,
  appleClientSecret,
  configuredProviders,
  finishAuthorization,
  isConfigured,
  openFlow,
  pkceChallenge,
  sealFlow,
  startAuthorization,
  verifyIdToken,
  type AuthFlow,
  type OAuthEnv,
} from '../../server/lib/oauth';

vi.setConfig({ testTimeout: 60_000 });

const SECRET = 'f'.repeat(64);
const NOW = 1_760_000_000_000;
const NOW_S = NOW / 1000;
const REDIRECT = 'https://exploratory.example/api/auth/callback';

let rsa: CryptoKeyPair;
let rsaOther: CryptoKeyPair;
let appleKey: CryptoKeyPair;
let applePem: string;
let env: OAuthEnv;

const genRsa = async () =>
  (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

beforeAll(async () => {
  rsa = await genRsa();
  rsaOther = await genRsa();
  appleKey = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = toBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', appleKey.privateKey)));
  applePem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  env = {
    GOOGLE_CLIENT_ID: 'google-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    APPLE_CLIENT_ID: 'xyz.hexplorers.web',
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_PRIVATE_KEY: applePem,
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'discord-secret',
  };
});

async function publicJwk(pair: CryptoKeyPair, kid: string) {
  return { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, use: 'sig', alg: 'RS256' };
}

interface Provider {
  calls: { url: string; init?: RequestInit }[];
  fetch: typeof fetch;
}

/** A pretend identity provider: token endpoint, JWKS and Discord's /users/@me. */
function provider(opts: {
  idToken?: () => Promise<string>;
  jwks?: () => Promise<object[]>;
  tokenStatus?: number;
  me?: object;
  cacheControl?: string;
}): Provider {
  const calls: Provider['calls'] = [];
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.endsWith('/token')) {
      if (opts.tokenStatus) return json({ error: 'invalid_grant' }, { status: opts.tokenStatus });
      return json({ access_token: 'access-abc', token_type: 'Bearer', expires_in: 3600, ...(opts.idToken ? { id_token: await opts.idToken() } : {}) });
    }
    if (url.includes('certs') || url.includes('/auth/keys')) {
      return json({ keys: await (opts.jwks ?? (async () => [await publicJwk(rsa, 'k1')]))() }, { headers: { 'Cache-Control': opts.cacheControl ?? 'public, max-age=3600' } });
    }
    if (url.endsWith('/users/@me')) return json(opts.me ?? {});
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: f };
}

function googleClaims(flow: AuthFlow, extra: Record<string, unknown> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: env.GOOGLE_CLIENT_ID,
    sub: '110169484474386276334',
    email: 'sailor@example.com',
    email_verified: true,
    name: 'Amber Gannet',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    iat: NOW_S - 10,
    exp: NOW_S + 3600,
    nonce: flow.nonce,
    ...extra,
  };
}

const sign = (claims: object, pair = rsa, kid = 'k1') => signJwt({ alg: 'RS256', kid }, claims, pair.privateKey);

describe('configuration', () => {
  it('each provider is off until all of its keys are set', () => {
    expect(configuredProviders({})).toEqual([]);
    expect(isConfigured('google', { GOOGLE_CLIENT_ID: 'x' })).toBe(false);
    expect(isConfigured('apple', { APPLE_CLIENT_ID: 'x', APPLE_TEAM_ID: 'y', APPLE_KEY_ID: 'z' })).toBe(false);
    expect(configuredProviders(env)).toEqual(['google', 'apple', 'discord']);
    expect(configuredProviders({ DISCORD_CLIENT_ID: 'a', DISCORD_CLIENT_SECRET: 'b' })).toEqual(['discord']);
  });
  it('refuses to start or finish an unconfigured provider', async () => {
    await expect(startAuthorization('google', {}, { redirectUri: REDIRECT })).rejects.toMatchObject({ code: 'not-configured' });
    await expect(finishAuthorization('google', {}, { code: 'c', state: 's', flow: null })).rejects.toMatchObject({ code: 'not-configured' });
  });
});

describe('authorize URLs and flows', () => {
  it('PKCE S256 matches RFC 7636 Appendix B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('Google: code + PKCE + state + nonce', async () => {
    const { url, flow } = await startAuthorization('google', env, { redirectUri: REDIRECT });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = Object.fromEntries(u.searchParams);
    expect(p).toMatchObject({
      response_type: 'code',
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge_method: 'S256',
    });
    expect(p.code_challenge).toBe(await pkceChallenge(flow.codeVerifier));
    expect(flow.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(url).not.toContain(env.GOOGLE_CLIENT_SECRET);
  });
  it('Apple: form_post with a nonce and no PKCE; Discord: PKCE with identify only', async () => {
    const apple = new URL((await startAuthorization('apple', env, { redirectUri: REDIRECT })).url);
    expect(apple.searchParams.get('response_mode')).toBe('form_post');
    expect(apple.searchParams.get('scope')).toBe('name email');
    expect(apple.searchParams.get('code_challenge')).toBeNull();
    expect(apple.searchParams.get('nonce')).toBeTruthy();
    const discord = new URL((await startAuthorization('discord', env, { redirectUri: REDIRECT, prompt: 'none' })).url);
    expect(discord.origin + discord.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(discord.searchParams.get('scope')).toBe('identify');
    expect(discord.searchParams.get('code_challenge_method')).toBe('S256');
    expect(discord.searchParams.get('prompt')).toBe('none');
  });
  it('seals a flow for a cookie and refuses a forged or stale one', async () => {
    const { flow } = await startAuthorization('google', env, { redirectUri: REDIRECT });
    const sealed = await sealFlow(flow, SECRET, NOW);
    expect(await openFlow(sealed, SECRET, NOW + 60_000)).toEqual(flow);
    expect(await openFlow(sealed, SECRET, NOW + 11 * 60_000)).toBeNull();
    expect(await openFlow(sealed, 'other-secret', NOW)).toBeNull();
    expect(await openFlow(undefined, SECRET)).toBeNull();
    expect(await openFlow(sealed.slice(0, -3) + 'AAA', SECRET, NOW)).toBeNull();
  });
});

describe('Google', () => {
  it('exchanges the code with the verifier and verifies the id_token', async () => {
    const { flow } = await startAuthorization('google', env, { redirectUri: REDIRECT });
    const idp = provider({ idToken: () => sign(googleClaims(flow)) });
    const jwks = new JwksCache();
    const id = await finishAuthorization('google', env, { code: 'code-1', state: flow.state, flow }, { fetch: idp.fetch, now: NOW, jwks });
    expect(id).toEqual({
      provider: 'google',
      subject: '110169484474386276334',
      email: 'sailor@example.com',
      emailVerified: true,
      name: 'Amber Gannet',
      avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
    });
    const token = idp.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')!;
    expect(token.init!.method).toBe('POST');
    const form = new URLSearchParams(String(token.init!.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: REDIRECT,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code_verifier: flow.codeVerifier,
    });
  });
  it('refuses a mismatched state before calling the provider', async () => {
    const { flow } = await startAuthorization('google', env, { redirectUri: REDIRECT });
    const idp = provider({ idToken: () => sign(googleClaims(flow)) });
    await expect(finishAuthorization('google', env, { code: 'c', state: 'nope', flow }, { fetch: idp.fetch })).rejects.toMatchObject({ code: 'state' });
    await expect(finishAuthorization('google', env, { code: 'c', state: flow.state, flow: null }, { fetch: idp.fetch })).rejects.toMatchObject({ code: 'state' });
    await expect(finishAuthorization('discord', env, { code: 'c', state: flow.state, flow }, { fetch: idp.fetch })).rejects.toMatchObject({ code: 'state' });
    expect(idp.calls).toEqual([]);
  });
  it('reports a refused code as an exchange error without echoing secrets', async () => {
    const { flow } = await startAuthorization('google', env, { redirectUri: REDIRECT });
    const idp = provider({ tokenStatus: 400 });
    const err = (await finishAuthorization('google', env, { code: 'c', state: flow.state, flow }, { fetch: idp.fetch }).catch((e) => e)) as OAuthError;
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toMatchObject({ code: 'exchange', status: 400 });
    expect(err.message).not.toContain(env.GOOGLE_CLIENT_SECRET!);
  });
  it('refuses id_tokens with the wrong audience, issuer, nonce, expiry, signature or algorithm', async () => {
    const { flow } = await startAuthorization('google', env, { redirectUri: REDIRECT });
    const bad: [string, () => Promise<string>][] = [
      ['audience', () => sign(googleClaims(flow, { aud: 'someone-else' }))],
      ['issuer', () => sign(googleClaims(flow, { iss: 'https://evil.example' }))],
      ['nonce', () => sign(googleClaims(flow, { nonce: 'replayed' }))],
      ['nonce', () => sign(googleClaims(flow, { nonce: undefined }))],
      ['expired', () => sign(googleClaims(flow, { exp: NOW_S - 120 }))],
      ['future', () => sign(googleClaims(flow, { iat: NOW_S + 600 }))],
      ['signature', () => sign(googleClaims(flow), rsaOther, 'k1')],
      ['unknown key', () => sign(googleClaims(flow), rsaOther, 'k9')],
      ['authorized party', () => sign(googleClaims(flow, { aud: [env.GOOGLE_CLIENT_ID, 'other'], azp: 'other' }))],
      ['algorithm', async () => {
        const t = await sign(googleClaims(flow));
        const [, p, s] = t.split('.');
        return `${btoa('{"alg":"none","typ":"JWT"}').replace(/=+$/, '')}.${p}.${s}`;
      }],
    ];
    for (const [why, idToken] of bad) {
      const idp = provider({ idToken });
      const err = await finishAuthorization('google', env, { code: 'c', state: flow.state, flow }, { fetch: idp.fetch, now: NOW, jwks: new JwksCache() }).catch((e) => e);
      expect(err, why).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code, why).toBe('id-token');
      expect((err as OAuthError).message, why).toMatch(new RegExp(why.split(' ')[0]!.replace('future', 'future')));
    }
  });
});

describe('JWKS caching', () => {
  it('fetches once, honours max-age, and refetches for a rotated key at most once a minute', async () => {
    const jwks = new JwksCache();
    let keys = [await publicJwk(rsa, 'k1')];
    const idp = provider({ jwks: async () => keys, cacheControl: 'public, max-age=600' });
    const check = { jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com'], audience: 'aud', fetch: idp.fetch, jwks };
    const claims = { iss: 'https://accounts.google.com', aud: 'aud', sub: 's', exp: NOW_S + 3600 };
    const t1 = await sign(claims);
    await verifyIdToken(t1, { ...check, now: NOW });
    await verifyIdToken(t1, { ...check, now: NOW + 1000 });
    expect(jwks.fetches).toBe(1);
    // After max-age (600 s) it refreshes.
    await verifyIdToken(t1, { ...check, now: NOW + 601_000 });
    expect(jwks.fetches).toBe(2);
    // A new key id appears: one refetch finds it.
    keys = [await publicJwk(rsa, 'k1'), await publicJwk(rsaOther, 'k2')];
    const t2 = await sign(claims, rsaOther, 'k2');
    await verifyIdToken(t2, { ...check, now: NOW + 700_000 });
    expect(jwks.fetches).toBe(3);
    // An unknown key id straight after: no hammering, it just fails.
    const t3 = await sign(claims, rsaOther, 'k3');
    await expect(verifyIdToken(t3, { ...check, now: NOW + 701_000 })).rejects.toMatchObject({ code: 'id-token' });
    expect(jwks.fetches).toBe(3);
  });
  it('keeps serving cached keys when a refresh fails', async () => {
    const jwks = new JwksCache();
    let up = true;
    const good = provider({});
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!up) throw new TypeError('offline');
      return good.fetch(input, init);
    }) as typeof fetch;
    const check = { jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com'], audience: 'aud', fetch: f, jwks };
    const t = await sign({ iss: 'https://accounts.google.com', aud: 'aud', sub: 's', exp: NOW_S + 86400 * 3 });
    await verifyIdToken(t, { ...check, now: NOW });
    up = false;
    await expect(verifyIdToken(t, { ...check, now: NOW + 2 * 3600_000 })).resolves.toMatchObject({ sub: 's' });
    await expect(verifyIdToken(t, { ...check, now: NOW, jwks: new JwksCache() })).rejects.toMatchObject({ code: 'id-token' });
  });
});

describe('Apple', () => {
  it('signs the client secret with the .p8 key (team, key id, client, audience)', async () => {
    const secret = await appleClientSecret(env, { now: NOW, ttlSeconds: 600 });
    const jwt = decodeJwt(secret);
    expect(jwt.header).toEqual({ typ: 'JWT', alg: 'ES256', kid: env.APPLE_KEY_ID });
    expect(jwt.payload).toEqual({ iss: env.APPLE_TEAM_ID, iat: NOW_S, exp: NOW_S + 600, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID });
    expect(await verifyJwtSignature(jwt, appleKey.publicKey, 'ES256')).toBe(true);
    // A PEM pasted into an env var with literal "\n" works too.
    const escaped = await appleClientSecret({ ...env, APPLE_PRIVATE_KEY: applePem.replace(/\n/g, '\\n') }, { now: NOW, ttlSeconds: 60 });
    expect(await verifyJwtSignature(escaped, appleKey.publicKey, 'ES256')).toBe(true);
    await expect(appleClientSecret({ ...env, APPLE_PRIVATE_KEY: 'not a key' }, { ttlSeconds: 60 })).rejects.toMatchObject({ code: 'not-configured' });
  });
  it('finishes a form_post callback: id_token, private relay email and the first-time name', async () => {
    const { flow } = await startAuthorization('apple', env, { redirectUri: REDIRECT });
    const idp = provider({
      idToken: () =>
        sign({
          iss: 'https://appleid.apple.com',
          aud: env.APPLE_CLIENT_ID,
          sub: '001234.abcdef.0123',
          email: 'x7y8@privaterelay.appleid.com',
          email_verified: 'true',
          is_private_email: 'true',
          iat: NOW_S,
          exp: NOW_S + 600,
          nonce: flow.nonce,
        }),
    });
    const id = await finishAuthorization(
      'apple',
      env,
      { code: 'c', state: flow.state, flow, appleUser: JSON.stringify({ name: { firstName: 'Wren', lastName: 'Marlow' }, email: 'ignored@example.com' }) },
      { fetch: idp.fetch, now: NOW, jwks: new JwksCache() },
    );
    expect(id).toEqual({
      provider: 'apple',
      subject: '001234.abcdef.0123',
      email: 'x7y8@privaterelay.appleid.com',
      emailVerified: true,
      privateEmail: true,
      name: 'Wren Marlow',
      avatarUrl: null,
    });
    const form = new URLSearchParams(String(idp.calls.find((c) => c.url.endsWith('/auth/token'))!.init!.body));
    expect(form.get('code_verifier')).toBeNull();
    expect(await verifyJwtSignature(form.get('client_secret')!, appleKey.publicKey, 'ES256')).toBe(true);
  });
});

describe('Discord', () => {
  it('exchanges the code with PKCE and reads /users/@me', async () => {
    const { flow } = await startAuthorization('discord', env, { redirectUri: REDIRECT });
    const idp = provider({
      me: { id: '80351110224678912', username: 'nelly', global_name: 'Nelly', avatar: '8342729096ea3675442027381ff50dfe', email: 'nelly@example.com', verified: true },
    });
    const id = await finishAuthorization('discord', env, { code: 'c', state: flow.state, flow }, { fetch: idp.fetch });
    expect(id).toEqual({
      provider: 'discord',
      subject: '80351110224678912',
      email: 'nelly@example.com',
      emailVerified: true,
      name: 'Nelly',
      avatarUrl: 'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png',
    });
    const form = new URLSearchParams(String(idp.calls[0]!.init!.body));
    expect(form.get('code_verifier')).toBe(flow.codeVerifier);
    expect(form.get('client_secret')).toBe(env.DISCORD_CLIENT_SECRET);
    expect(new Headers(idp.calls[1]!.init!.headers).get('Authorization')).toBe('Bearer access-abc');
  });
  it('falls back to the username, drops a bad avatar and refuses a profile without an id', async () => {
    const { flow } = await startAuthorization('discord', env, { redirectUri: REDIRECT });
    const idp = provider({ me: { id: '1', username: 'old_style', avatar: '"><script>' } });
    const id = await finishAuthorization('discord', env, { code: 'c', state: flow.state, flow }, { fetch: idp.fetch });
    expect(id).toMatchObject({ name: 'old_style', avatarUrl: null, email: null, emailVerified: false });
    const none = provider({ me: { username: 'x' } });
    await expect(finishAuthorization('discord', env, { code: 'c', state: flow.state, flow }, { fetch: none.fetch })).rejects.toMatchObject({ code: 'profile' });
  });
});
