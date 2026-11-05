// server/lib/oauth: sign in with Google, Apple or Discord (OAuth 2.0 authorization code; OpenID Connect
// id_tokens for Google and Apple).
//
// Off until keyed: a provider is on only when all of its env values are set (isConfigured).
//   google:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   apple:   APPLE_CLIENT_ID (the Services ID), APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (.p8 PEM)
//   discord: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
//
// The flow:
//   const { url, flow } = await startAuthorization('google', env, { redirectUri: `${env.PUBLIC_URL}/api/auth/google/callback` });
//   setCookie('oauth', await sealFlow(flow, env.TOKEN_SECRET));      // HttpOnly, Secure, ≤ 10 minutes
//   redirect(url);
//   // ... the provider sends the browser back with ?code&state (Apple: a form POST, see below)
//   const flow = await openFlow(cookie, env.TOKEN_SECRET);           // null when missing, forged or expired
//   const id = await finishAuthorization('google', env, { code, state, flow });
//   // id = { provider, subject, email, emailVerified, name, avatarUrl }
//
// Google and Discord use PKCE (S256) as well as state. Apple's endpoints don't take PKCE, so Apple's
// flow relies on state plus the id_token nonce. Apple returns with response_mode=form_post: a
// cross-site POST, which doesn't carry SameSite=Lax cookies, so its flow cookie must be
// SameSite=None; Secure. Its form also carries `user` (the name, on the first sign-in only).
//
// id_tokens are verified against the provider's JWKS (cached, see jwks.ts): signature (RS256), iss,
// aud, exp, iat and nonce. Errors are OAuthError with a code and never include tokens or secrets.

import type { ServerEnv } from '../../core/ports';
import { decodeJwt, importPkcs8Pem, randomId, sha256, signJwt, signToken, timingSafeEqual, toBase64Url, verifyJwtSignature, verifyToken, type JwtAlg } from '../crypto';
import { sharedJwks, type JwksCache } from './jwks';

export { JwksCache, sharedJwks } from './jwks';

export type ProviderId = 'google' | 'apple' | 'discord';
export const PROVIDER_IDS: readonly ProviderId[] = ['google', 'apple', 'discord'];

export type OAuthEnv = Pick<
  ServerEnv,
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'APPLE_CLIENT_ID'
  | 'APPLE_TEAM_ID'
  | 'APPLE_KEY_ID'
  | 'APPLE_PRIVATE_KEY'
  | 'DISCORD_CLIENT_ID'
  | 'DISCORD_CLIENT_SECRET'
>;

export type OAuthErrorCode = 'not-configured' | 'state' | 'exchange' | 'id-token' | 'profile';

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  pkce: boolean;
  responseMode?: 'form_post';
  oidc?: { jwksUrl: string; issuers: string[] };
  profileUrl?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: ['openid', 'email', 'profile'],
    pkce: true,
    oidc: { jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'] },
  },
  apple: {
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    defaultScopes: ['name', 'email'],
    pkce: false,
    responseMode: 'form_post',
    oidc: { jwksUrl: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'] },
  },
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    defaultScopes: ['identify'],
    pkce: true,
    profileUrl: 'https://discord.com/api/users/@me',
  },
};

/** Whether a provider has every key it needs. */
export function isConfigured(provider: ProviderId, env: OAuthEnv): boolean {
  switch (provider) {
    case 'google':
      return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    case 'apple':
      return Boolean(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
    case 'discord':
      return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
  }
}

/** The providers that are on, for GET /api/config. */
export function configuredProviders(env: OAuthEnv): ProviderId[] {
  return PROVIDER_IDS.filter((p) => isConfigured(p, env));
}

function clientId(provider: ProviderId, env: OAuthEnv): string {
  const id = provider === 'google' ? env.GOOGLE_CLIENT_ID : provider === 'apple' ? env.APPLE_CLIENT_ID : env.DISCORD_CLIENT_ID;
  if (!id || !isConfigured(provider, env)) throw new OAuthError('not-configured', `${provider} sign-in is not configured`);
  return id;
}

/** What the caller keeps (sealed in a short-lived cookie) between the redirect and the callback. */
export interface AuthFlow {
  provider: ProviderId;
  state: string;
  /** PKCE verifier (unused for Apple). */
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await sha256(verifier));
}

/** The provider's authorize URL and the flow to keep. */
export async function startAuthorization(
  provider: ProviderId,
  env: OAuthEnv,
  options: { redirectUri: string; scopes?: string[]; prompt?: string },
): Promise<{ url: string; flow: AuthFlow }> {
  const spec = PROVIDERS[provider];
  const flow: AuthFlow = {
    provider,
    state: randomId(24),
    codeVerifier: randomId(32), // 43 characters, the RFC 7636 minimum
    nonce: randomId(24),
    redirectUri: options.redirectUri,
  };
  const url = new URL(spec.authorizeUrl);
  const params = url.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', clientId(provider, env));
  params.set('redirect_uri', options.redirectUri);
  params.set('scope', (options.scopes ?? spec.defaultScopes).join(' '));
  params.set('state', flow.state);
  if (spec.oidc) params.set('nonce', flow.nonce);
  if (spec.pkce) {
    params.set('code_challenge', await pkceChallenge(flow.codeVerifier));
    params.set('code_challenge_method', 'S256');
  }
  if (spec.responseMode) params.set('response_mode', spec.responseMode);
  if (options.prompt) params.set('prompt', options.prompt);
  return { url: url.toString(), flow };
}

/** How long a sealed flow lives. */
export const FLOW_TTL_MS = 10 * 60_000;

/** Sign a flow for a cookie (it is signed, not encrypted: it holds only random values and the redirect). */
export function sealFlow(flow: AuthFlow, secret: string, now?: number): Promise<string> {
  return signToken(flow, secret, FLOW_TTL_MS, { purpose: 'oauth-flow', now });
}

/** A sealed flow back, or null when it is missing, forged or expired. */
export async function openFlow(sealed: string | null | undefined, secret: string, now?: number): Promise<AuthFlow | null> {
  if (!sealed) return null;
  const r = await verifyToken<AuthFlow>(sealed, secret, { purpose: 'oauth-flow', now });
  if (!r.ok) return null;
  const f = r.payload;
  if (!f || !PROVIDER_IDS.includes(f.provider) || typeof f.state !== 'string' || typeof f.codeVerifier !== 'string' || typeof f.nonce !== 'string' || typeof f.redirectUri !== 'string') {
    return null;
  }
  return f;
}

// ------------------------------------------------------------------ Apple's client secret

const appleSecrets = new Map<string, { secret: string; exp: number }>();

/**
 * Apple's client_secret: an ES256 JWT signed with the .p8 key (iss team id, sub client id, aud
 * https://appleid.apple.com, at most six months). Cached until five minutes before it expires.
 */
export async function appleClientSecret(env: OAuthEnv, options: { now?: number; ttlSeconds?: number } = {}): Promise<string> {
  if (!isConfigured('apple', env)) throw new OAuthError('not-configured', 'apple sign-in is not configured');
  const nowS = Math.floor((options.now ?? Date.now()) / 1000);
  const cacheKey = `${env.APPLE_TEAM_ID}|${env.APPLE_KEY_ID}|${env.APPLE_CLIENT_ID}`;
  const cached = appleSecrets.get(cacheKey);
  if (cached && cached.exp - nowS > 300 && options.ttlSeconds === undefined) return cached.secret;
  const ttl = Math.min(options.ttlSeconds ?? 3600, 15_777_000);
  let key: CryptoKey;
  try {
    key = await importPkcs8Pem(env.APPLE_PRIVATE_KEY!, 'ES256');
  } catch {
    throw new OAuthError('not-configured', 'APPLE_PRIVATE_KEY is not a PKCS#8 P-256 key');
  }
  const exp = nowS + ttl;
  const secret = await signJwt(
    { alg: 'ES256', kid: env.APPLE_KEY_ID! },
    { iss: env.APPLE_TEAM_ID, iat: nowS, exp, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID },
    key,
  );
  if (options.ttlSeconds === undefined) appleSecrets.set(cacheKey, { secret, exp });
  return secret;
}

// ------------------------------------------------------------------ id_tokens

export interface IdTokenCheck {
  jwksUrl: string;
  issuers: string[];
  audience: string;
  /** The nonce sent in the authorize URL; the token must carry it. */
  nonce?: string;
  algorithms?: JwtAlg[];
  now?: number;
  /** Allowed clock difference in seconds (default 60). */
  clockSkew?: number;
  fetch?: typeof fetch;
  jwks?: JwksCache;
}

/** Verify an OpenID Connect id_token and return its claims. Throws OAuthError('id-token'). */
export async function verifyIdToken(idToken: string, check: IdTokenCheck): Promise<Record<string, unknown>> {
  const bad = (why: string): never => {
    throw new OAuthError('id-token', `id_token rejected: ${why}`);
  };
  let jwt;
  try {
    jwt = decodeJwt(idToken);
  } catch {
    return bad('malformed');
  }
  const algs = check.algorithms ?? ['RS256'];
  const alg = jwt.header.alg as JwtAlg;
  if (!algs.includes(alg)) return bad('algorithm');
  const kid = typeof jwt.header.kid === 'string' ? jwt.header.kid : undefined;
  let key: CryptoKey | null;
  try {
    key = await (check.jwks ?? sharedJwks).getKey(check.jwksUrl, kid, alg, { fetch: check.fetch, now: check.now });
  } catch {
    return bad('signing keys unavailable');
  }
  if (!key) return bad('unknown key');
  if (!(await verifyJwtSignature(jwt, key, alg))) return bad('signature');
  const c = jwt.payload;
  const nowS = Math.floor((check.now ?? Date.now()) / 1000);
  const skew = check.clockSkew ?? 60;
  if (typeof c.iss !== 'string' || !check.issuers.includes(c.iss)) return bad('issuer');
  const aud = c.aud;
  if (typeof aud === 'string' ? aud !== check.audience : !Array.isArray(aud) || !aud.includes(check.audience)) return bad('audience');
  if (Array.isArray(aud) && aud.length > 1 && c.azp !== check.audience) return bad('authorized party');
  if (typeof c.exp !== 'number' || c.exp + skew <= nowS) return bad('expired');
  if (typeof c.iat === 'number' && c.iat - skew > nowS) return bad('issued in the future');
  if (typeof c.sub !== 'string' || c.sub.length === 0 || c.sub.length > 255) return bad('subject');
  if (check.nonce !== undefined && (typeof c.nonce !== 'string' || !timingSafeEqual(c.nonce, check.nonce))) return bad('nonce');
  return c;
}

// ------------------------------------------------------------------ the callback

export interface OAuthIdentity {
  provider: ProviderId;
  /** The provider's stable user id (OIDC `sub`, Discord's snowflake). */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
  /** Apple's Hide My Email relay address. */
  privateEmail?: boolean;
}

export interface FinishInput {
  code: string;
  state: string;
  flow: AuthFlow | null;
  /** Apple's form_post `user` field (JSON with the name), when present. */
  appleUser?: string;
}

export interface OAuthDeps {
  fetch?: typeof fetch;
  now?: number;
  jwks?: JwksCache;
}

async function exchangeCode(provider: ProviderId, env: OAuthEnv, input: FinishInput & { flow: AuthFlow }, deps: OAuthDeps): Promise<Record<string, unknown>> {
  const spec = PROVIDERS[provider];
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.flow.redirectUri,
    client_id: clientId(provider, env),
  });
  if (provider === 'google') form.set('client_secret', env.GOOGLE_CLIENT_SECRET!);
  if (provider === 'discord') form.set('client_secret', env.DISCORD_CLIENT_SECRET!);
  if (provider === 'apple') form.set('client_secret', await appleClientSecret(env, { now: deps.now }));
  if (spec.pkce) form.set('code_verifier', input.flow.codeVerifier);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(spec.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form,
    });
  } catch {
    throw new OAuthError('exchange', `${provider} token endpoint unreachable`);
  }
  if (!response.ok) throw new OAuthError('exchange', `${provider} refused the code`, response.status);
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthError('exchange', `${provider} token response is not JSON`);
  }
}

function appleName(user: string | undefined): string | null {
  if (!user || user.length > 4096) return null;
  try {
    const parsed = JSON.parse(user) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed.name?.firstName, parsed.name?.lastName].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    return parts.length ? parts.join(' ').trim() : null;
  } catch {
    return null;
  }
}

/** Check the callback against the flow, exchange the code and return who signed in. */
export async function finishAuthorization(provider: ProviderId, env: OAuthEnv, input: FinishInput, deps: OAuthDeps = {}): Promise<OAuthIdentity> {
  if (!isConfigured(provider, env)) throw new OAuthError('not-configured', `${provider} sign-in is not configured`);
  const flow = input.flow;
  if (!flow || flow.provider !== provider || typeof input.state !== 'string' || !timingSafeEqual(input.state, flow.state)) {
    throw new OAuthError('state', 'sign-in state did not match');
  }
  if (typeof input.code !== 'string' || input.code.length === 0 || input.code.length > 2048) throw new OAuthError('exchange', 'missing code');
  const tokens = await exchangeCode(provider, env, { ...input, flow }, deps);

  if (provider === 'discord') {
    const access = tokens.access_token;
    if (typeof access !== 'string') throw new OAuthError('exchange', 'discord sent no access token');
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(PROVIDERS.discord.profileUrl!, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } });
    } catch {
      throw new OAuthError('profile', 'discord profile unreachable');
    }
    if (!response.ok) throw new OAuthError('profile', 'discord refused the profile request', response.status);
    const me = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!me || typeof me.id !== 'string' || !/^\d{1,25}$/.test(me.id)) throw new OAuthError('profile', 'discord profile has no id');
    const name = typeof me.global_name === 'string' && me.global_name ? me.global_name : typeof me.username === 'string' ? me.username : null;
    const avatar = typeof me.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(me.avatar) ? me.avatar : null;
    const verified = me.verified === true;
    return {
      provider,
      subject: me.id,
      email: typeof me.email === 'string' ? me.email : null,
      emailVerified: verified && typeof me.email === 'string',
      name,
      avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${avatar}.png` : null,
    };
  }

  const idToken = tokens.id_token;
  if (typeof idToken !== 'string') throw new OAuthError('exchange', `${provider} sent no id_token`);
  const spec = PROVIDERS[provider];
  const claims = await verifyIdToken(idToken, {
    jwksUrl: spec.oidc!.jwksUrl,
    issuers: spec.oidc!.issuers,
    audience: clientId(provider, env),
    nonce: flow.nonce,
    now: deps.now,
    fetch: deps.fetch,
    jwks: deps.jwks,
  });
  const email = typeof claims.email === 'string' ? claims.email : null;
  const emailVerified = email !== null && (claims.email_verified === true || claims.email_verified === 'true');
  if (provider === 'google') {
    return {
      provider,
      subject: claims.sub as string,
      email,
      emailVerified,
      name: typeof claims.name === 'string' ? claims.name : null,
      avatarUrl: typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null,
    };
  }
  return {
    provider,
    subject: claims.sub as string,
    email,
    emailVerified,
    name: appleName(input.appleUser),
    avatarUrl: null,
    privateEmail: claims.is_private_email === true || claims.is_private_email === 'true',
  };
}
