// The ways into an account, under /api/auth: passkeys (on everywhere: the RP id is PUBLIC_URL's
// host), Google, Apple and Discord (each off until its keys are set: a 501 with code 'off'), and a
// magic link by email (off until RESEND_API_KEY and EMAIL_FROM are set); then picking up a
// provider's session, signing out and the list of sessions. A sign-in made with a guest's token
// upgrades that guest (the same id) or, into an account that already exists, brings the guest's
// record along. Flows are signed and short-lived: a passkey's challenge rides back with the answer,
// a provider's state in an HttpOnly cookie, and each is used once.

import * as v from 'valibot';
import { check } from '../../../src/net/schema';
import { body, bearer, fail, json, limited, originAllowed, who, type Handler, type HttpContext, type Route } from '../../http/kit';
import { signToken, timingSafeEqual, toBase64Url, verifyToken } from '../../lib/crypto';
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration, type AuthenticationResponseJSON, type CoseAlg, type RegistrationResponseJSON } from '../../lib/webauthn';
import { FLOW_TTL_MS, OAuthError, PROVIDER_IDS, finishAuthorization, isConfigured as providerOn, openFlow, sealFlow, startAuthorization, type AuthFlow, type OAuthDeps, type ProviderId } from '../../lib/oauth';
import { createMagicLink, emailHash, isConfigured as emailOn, isPlausibleEmail, magicLinkUrl, normalizeEmail, sendEmail, signInEmail, verifyMagicCode, verifyMagicLink, MAGIC_TTL_MS, type MagicResult } from '../../lib/email';
import {
  absorbGuest, ageBand, becomeAccount, consume, cookie, deviceLabel, freeHandle, readCookie, sessionId, signedIn, siteOrigin, siteOrigins, issueSession, type AccountSettings,
} from './core';

const PASSKEY_FLOW_MS = 5 * 60_000;
/** The provider's session waits this long in its cookie for the page to pick it up. */
const CLAIM_MS = 2 * 60_000;
const FLOW_COOKIE = 'xo_flow';
const CLAIM_COOKIE = 'xo_claim';
const NAMES: Record<ProviderId, string> = { google: 'Google', apple: 'Apple', discord: 'Discord' };

/** What the providers' and the mailer's calls go through (tests put a stand-in for the network here). */
export const outside: { oauth: OAuthDeps; fetch?: typeof fetch } = { oauth: {} };

const device = (req: Request) => deviceLabel(req.headers.get('user-agent'));
const deps = (ctx: HttpContext) => ctx;

/** The answer's settings from the sign-up sheet: a birth year's band (the year itself is dropped) and the chat opt-in. */
const SignUpSchema = v.optional(v.strictObject({ birthYear: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1900), v.maxValue(2100))), chat: v.optional(v.picklist(['quick', 'free'])) }));

function signUpSettings(s: v.InferOutput<typeof SignUpSchema>, now: number): AccountSettings {
  const out: AccountSettings = {};
  if (s?.birthYear !== undefined) out.ageBand = ageBand(s.birthYear, now);
  if (s?.chat === 'free' && out.ageBand && out.ageBand !== 'u13') out.chat = 'free';
  return out;
}

// ------------------------------------------------------------------ passkeys

const rpId = (ctx: HttpContext) => new URL(ctx.env.PUBLIC_URL).hostname;

const RegisterVerifySchema = v.strictObject({ flow: v.pipe(v.string(), v.maxLength(2048)), response: v.unknown(), settings: SignUpSchema });
const LoginVerifySchema = v.strictObject({ flow: v.pipe(v.string(), v.maxLength(2048)), response: v.unknown() });

const registerOptions: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'passkey', 30, 30)) return fail(429, 'Too many tries from here: wait a minute.');
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  const existing = id.guest ? [] : await ctx.db.all<{ id: string; transports: string }>('SELECT id, transports FROM passkeys WHERE user = ?', id.user);
  // (A guest's handle is chosen now, so the passkey is saved under the name it will have.)
  const handle = id.handle ?? (await freeHandle(deps(ctx), id.name));
  const { options, challenge } = registrationOptions({
    rpId: rpId(ctx),
    rpName: 'Hexplorers',
    user: { id: id.user, name: handle, displayName: id.name },
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) as string[] })),
    challenge: ctx.random(32),
  });
  const flow = await signToken({ c: challenge, u: id.user, h: handle }, ctx.env.TOKEN_SECRET, PASSKEY_FLOW_MS, { purpose: 'passkey-register', now: ctx.now() });
  return json(200, { options, flow });
};

const registerVerify: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'passkey', 30, 30)) return fail(429, 'Too many tries from here: wait a minute.');
  const b = check(RegisterVerifySchema, await body(req, 32_768));
  if (!b) return fail(400, 'Bad body.');
  const f = await verifyToken<{ c: string; u: string; h: string }>(b.flow, ctx.env.TOKEN_SECRET, { purpose: 'passkey-register', now: ctx.now() });
  if (!f.ok) return fail(400, 'That took too long: try again.', 'flow');
  const id = await who(req, ctx);
  if (!id || id.user !== f.payload.u) return fail(401, 'Sign in again.');
  if (!(await consume(deps(ctx), `pk:${f.payload.c}`, f.exp))) return fail(400, 'That was used already: try again.', 'flow');
  const r = await verifyRegistration({ response: b.response as RegistrationResponseJSON, expectedChallenge: f.payload.c, expectedOrigins: siteOrigins(ctx.env), expectedRpId: rpId(ctx) });
  if (!r.ok) return fail(400, 'The passkey couldn’t be checked. Try again.', r.error);
  const c = r.credential;
  if (await ctx.db.first('SELECT id FROM passkeys WHERE id = ?', c.id)) return fail(409, 'That passkey is saved already.', 'credential');
  const user = id.guest ? await becomeAccount(deps(ctx), { guest: id.user, handle: f.payload.h, settings: signUpSettings(b.settings, ctx.now()) }) : id.user;
  await ctx.db.run(
    'INSERT INTO passkeys(id, user, public_key, alg, sign_count, transports, backed_up, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    c.id, user, JSON.stringify(c.publicKey), c.alg, c.signCount, JSON.stringify(c.transports), c.backedUp ? 1 : 0, device(req), ctx.now(),
  );
  if (!id.guest) return json(200, { added: true });
  return json(201, await signedIn(deps(ctx), user, await issueSession(deps(ctx), user, device(req))));
};

const loginOptions: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'passkey', 30, 30)) return fail(429, 'Too many tries from here: wait a minute.');
  // (No allowCredentials: a passkey is discoverable, so the device offers the ones it has.)
  const { options, challenge } = authenticationOptions({ rpId: rpId(ctx), challenge: ctx.random(32) });
  const flow = await signToken({ c: challenge }, ctx.env.TOKEN_SECRET, PASSKEY_FLOW_MS, { purpose: 'passkey-login', now: ctx.now() });
  return json(200, { options, flow });
};

const loginVerify: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'passkey', 30, 30)) return fail(429, 'Too many tries from here: wait a minute.');
  const b = check(LoginVerifySchema, await body(req, 16_384));
  if (!b) return fail(400, 'Bad body.');
  const f = await verifyToken<{ c: string }>(b.flow, ctx.env.TOKEN_SECRET, { purpose: 'passkey-login', now: ctx.now() });
  if (!f.ok) return fail(400, 'That took too long: try again.', 'flow');
  const response = b.response as AuthenticationResponseJSON;
  const credId = typeof response?.id === 'string' ? response.id.slice(0, 1400) : '';
  const cred = await ctx.db.first<{ id: string; user: string; public_key: string; alg: number; sign_count: number }>('SELECT id, user, public_key, alg, sign_count FROM passkeys WHERE id = ?', credId);
  if (!cred) return fail(400, 'That passkey isn’t known here.', 'credential');
  if (!(await consume(deps(ctx), `pk:${f.payload.c}`, f.exp))) return fail(400, 'That was used already: try again.', 'flow');
  const a = await verifyAuthentication({
    response,
    expectedChallenge: f.payload.c,
    expectedOrigins: siteOrigins(ctx.env),
    expectedRpId: rpId(ctx),
    credential: { id: cred.id, publicKey: JSON.parse(cred.public_key) as JsonWebKey, alg: cred.alg as CoseAlg, signCount: cred.sign_count },
  });
  if (!a.ok) return fail(400, 'The passkey couldn’t be checked. Try again.', a.error);
  if (a.userHandle !== null && a.userHandle !== toBase64Url(cred.user)) return fail(400, 'That passkey belongs to someone else.', 'credential');
  const owner = await ctx.db.first<{ banned_at: number | null }>('SELECT banned_at FROM users WHERE id = ?', cred.user);
  if (!owner) return fail(400, 'That passkey’s account is gone.', 'credential');
  if (owner.banned_at) return fail(403, 'This account can’t sign in.', 'banned');
  await ctx.db.run('UPDATE passkeys SET sign_count = ?, backed_up = ?, used_at = ? WHERE id = ?', a.signCount, a.backedUp ? 1 : 0, ctx.now(), cred.id);
  const id = await who(req, ctx);
  if (id?.guest) await absorbGuest(deps(ctx), id.user, cred.user);
  return json(200, await signedIn(deps(ctx), cred.user, await issueSession(deps(ctx), cred.user, device(req))));
};

// ------------------------------------------------------------------ Google, Apple, Discord

const providerOf = (p: string): ProviderId | null => ((PROVIDER_IDS as readonly string[]).includes(p) ? (p as ProviderId) : null);
const redirectUri = (ctx: HttpContext, p: ProviderId) => `${siteOrigin(ctx.env)}/api/auth/oauth/${p}/callback`;

/** Whether a provider is there to use: null when it is, or the answer that says it isn't. */
function providerGate(p: string, ctx: HttpContext): ProviderId | Response {
  const provider = providerOf(p);
  if (!provider) return fail(404, 'No such way to sign in.');
  if (!providerOn(provider, ctx.env)) return fail(501, `${NAMES[provider]} sign-in isn’t set up on this server.`, 'off');
  return provider;
}

type Flow = AuthFlow & { up?: string | null };

const oauthStart: Handler = async (req, p, ctx) => {
  const provider = providerGate(p.provider, ctx);
  if (provider instanceof Response) return provider;
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'oauth', 20, 20)) return fail(429, 'Too many tries from here: wait a minute.');
  const id = await who(req, ctx);
  const { url, flow } = await startAuthorization(provider, ctx.env, { redirectUri: redirectUri(ctx, provider) });
  // (Who is signing in rides along, so the callback upgrades that guest or adds this way in to that account.)
  const sealed = await sealFlow({ ...flow, up: id?.user ?? null } as Flow, ctx.env.TOKEN_SECRET, ctx.now());
  // Apple comes back with a cross-site form POST, which only carries a SameSite=None cookie.
  const set = cookie(ctx.env, FLOW_COOKIE, sealed, { path: '/api/auth/oauth', maxAge: FLOW_TTL_MS / 1000, sameSite: provider === 'apple' ? 'None' : 'Lax' });
  return json(200, { url }, { 'set-cookie': set });
};

const oauthCallback: Handler = async (req, p, ctx) => {
  const provider = providerGate(p.provider, ctx);
  if (provider instanceof Response) return provider;
  const back = (ok: boolean, setCookie?: string) =>
    new Response(null, { status: 303, headers: { location: `${siteOrigin(ctx.env)}/?go=/multi#${ok ? 'signin' : 'signin-failed'}`, 'cache-control': 'no-store', ...(setCookie && { 'set-cookie': setCookie }) } });
  if (await limited(ctx, 'oauth', 20, 20)) return back(false);
  let q: URLSearchParams;
  if (req.method === 'POST') {
    const text = await req.text();
    if (text.length > 16_384) return back(false);
    q = new URLSearchParams(text);
  } else q = new URL(req.url).searchParams;
  const flow = (await openFlow(readCookie(req, FLOW_COOKIE), ctx.env.TOKEN_SECRET, ctx.now())) as Flow | null;
  if (!flow || q.get('error')) return back(false);
  // (The state matched, then spent, before the code goes to the provider: a callback replayed never reaches it.)
  if (!timingSafeEqual(q.get('state') ?? '', flow.state) || !(await consume(deps(ctx), `oauth:${flow.state}`, ctx.now() + FLOW_TTL_MS))) return back(false);
  let ident;
  try {
    ident = await finishAuthorization(provider, ctx.env, { code: q.get('code') ?? '', state: q.get('state') ?? '', flow, appleUser: q.get('user') ?? undefined }, { ...outside.oauth, now: ctx.now() });
  } catch (e) {
    console.warn(JSON.stringify({ ev: 'oauthFailed', provider, code: e instanceof OAuthError ? e.code : 'error' }));
    return back(false);
  }
  const linked = await ctx.db.first<{ user: string }>('SELECT user FROM oauth_links WHERE provider = ? AND subject = ?', provider, ident.subject);
  let user: string;
  if (linked) {
    user = linked.user;
    if (flow.up) await absorbGuest(deps(ctx), flow.up, user);
  } else {
    // (The provider's name and address are never taken: the guest's name stays, and an address only
    // comes from someone asking for letters by email.)
    user = await becomeAccount(deps(ctx), { guest: flow.up ?? null });
    await ctx.db.run('INSERT OR IGNORE INTO oauth_links(provider, subject, user, created_at) VALUES (?, ?, ?, ?)', provider, ident.subject, user, ctx.now());
  }
  const owner = await ctx.db.first<{ banned_at: number | null }>('SELECT banned_at FROM users WHERE id = ?', user);
  if (!owner || owner.banned_at) return back(false);
  const token = await issueSession(deps(ctx), user, device(req));
  const claim = await signToken({ t: token }, ctx.env.TOKEN_SECRET, CLAIM_MS, { purpose: 'claim', now: ctx.now() });
  return back(true, cookie(ctx.env, CLAIM_COOKIE, claim, { path: '/api/auth/claim', maxAge: CLAIM_MS / 1000 }));
};

/** The page, back from a provider, picks up the session the callback left in its cookie. */
const claim: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const clear = { 'set-cookie': cookie(ctx.env, CLAIM_COOKIE, '', { path: '/api/auth/claim', maxAge: 0 }) };
  const sealed = readCookie(req, CLAIM_COOKIE);
  if (!sealed) return json(404, { error: 'Nothing to pick up.', code: 'none' }, clear);
  const r = await verifyToken<{ t?: unknown }>(sealed, ctx.env.TOKEN_SECRET, { purpose: 'claim', now: ctx.now() });
  const token = r.ok && typeof r.payload?.t === 'string' ? r.payload.t : null;
  const sid = sessionId(token);
  const id = token ? await ctx.services.identify(token) : null;
  if (!r.ok || !token || !sid || !id || id.guest || !(await consume(deps(ctx), `claim:${sid}`, r.exp))) return json(400, { error: 'That sign-in ran out: try again.', code: 'claim' }, clear);
  return json(200, await signedIn(deps(ctx), id.user, token), clear);
};

// ------------------------------------------------------------------ a magic link by email

const EmailStartSchema = v.strictObject({ email: v.pipe(v.string(), v.maxLength(254)), notify: v.optional(v.boolean()) });
const EmailVerifySchema = v.strictObject({
  token: v.optional(v.pipe(v.string(), v.maxLength(4096))),
  email: v.optional(v.pipe(v.string(), v.maxLength(254))),
  code: v.optional(v.pipe(v.string(), v.maxLength(12))),
  settings: SignUpSchema,
});
const CODE_TRIES = 5;

function emailGate(ctx: HttpContext): Response | null {
  return emailOn(ctx.env) ? null : fail(501, 'Email sign-in isn’t set up on this server.', 'off');
}

const emailStart: Handler = async (req, _p, ctx) => {
  const off = emailGate(ctx);
  if (off) return off;
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'email', 5, 5)) return fail(429, 'Too many letters from here: wait a minute.');
  const b = check(EmailStartSchema, await body(req, 1024));
  if (!b || !isPlausibleEmail(b.email.trim())) return fail(400, 'That doesn’t look like an email address.');
  const email = b.email.trim();
  const link = await createMagicLink(email, ctx.env.TOKEN_SECRET, { now: ctx.now() });
  // (One letter a minute to an address, whoever asks: the answer is the same either way.)
  const pending = await ctx.db.first<{ exp: number }>('SELECT exp FROM email_pending WHERE hash = ?', link.emailHash);
  if (pending && pending.exp - MAGIC_TTL_MS > ctx.now() - 60_000) return json(202, { sent: true });
  await ctx.db.run(
    'INSERT INTO email_pending(hash, nonce, exp, attempts, address) VALUES (?, ?, ?, 0, ?) ON CONFLICT(hash) DO UPDATE SET nonce = excluded.nonce, exp = excluded.exp, attempts = 0, address = excluded.address',
    link.emailHash, link.nonce, link.exp, b.notify ? normalizeEmail(email) : null,
  );
  const mail = signInEmail({ url: magicLinkUrl(ctx.env.PUBLIC_URL, link.token, '/?go=/multi'), code: link.code });
  const sent = await sendEmail(ctx.env, { to: email, ...mail, tags: [{ name: 'kind', value: 'magic' }] }, { fetch: outside.fetch });
  if (!sent.ok) return fail(502, 'The letter couldn’t be sent. Try again in a moment.', sent.error);
  return json(202, { sent: true });
};

const emailVerify: Handler = async (req, _p, ctx) => {
  const off = emailGate(ctx);
  if (off) return off;
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  if (await limited(ctx, 'email-verify', 10, 10)) return fail(429, 'Too many tries from here: wait a minute.');
  const b = check(EmailVerifySchema, await body(req, 8192));
  if (!b) return fail(400, 'Bad body.');
  const use = (nonce: string, exp: number) => consume(deps(ctx), `magic:${nonce}`, exp);
  let r: MagicResult;
  if (b.token) r = await verifyMagicLink(b.token, ctx.env.TOKEN_SECRET, { consume: use, now: ctx.now() });
  else if (b.email && b.code) {
    const hash = await emailHash(b.email, ctx.env.TOKEN_SECRET);
    const pending = await ctx.db.first<{ nonce: string; exp: number; attempts: number }>('SELECT nonce, exp, attempts FROM email_pending WHERE hash = ?', hash);
    if (!pending || pending.attempts >= CODE_TRIES) return fail(400, 'That code has run out: ask for a new letter.', 'code');
    await ctx.db.run('UPDATE email_pending SET attempts = attempts + 1 WHERE hash = ?', hash);
    r = await verifyMagicCode(b.code, { nonce: pending.nonce, exp: pending.exp, emailHash: hash }, ctx.env.TOKEN_SECRET, { consume: use, now: ctx.now() });
  } else return fail(400, 'A link or a code, please.');
  if (!r.ok) {
    const why = r.reason === 'expired' ? 'That letter has expired: ask for a new one.' : r.reason === 'used' ? 'That letter was used already.' : 'That doesn’t match: check it and try again.';
    return fail(400, why, r.reason);
  }
  const pending = await ctx.db.first<{ address: string | null }>('SELECT address FROM email_pending WHERE hash = ?', r.emailHash);
  await ctx.db.run('DELETE FROM email_pending WHERE hash = ?', r.emailHash);
  const address = pending?.address ?? null;
  const known = await ctx.db.first<{ user: string }>('SELECT user FROM emails WHERE hash = ?', r.emailHash);
  const id = await who(req, ctx);
  let user: string;
  if (known) {
    user = known.user;
    if (id?.guest) await absorbGuest(deps(ctx), id.user, user);
    if (address) await ctx.db.run('UPDATE emails SET address = ?, notify = 1 WHERE user = ?', address, user);
  } else {
    user = id && !id.guest ? id.user : await becomeAccount(deps(ctx), { guest: id?.user ?? null, settings: signUpSettings(b.settings, ctx.now()) });
    await ctx.db.run(
      'INSERT INTO emails(user, hash, address, notify, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user) DO UPDATE SET hash = excluded.hash, address = excluded.address, notify = excluded.notify',
      user, r.emailHash, address, address ? 1 : 0, ctx.now(),
    );
  }
  const owner = await ctx.db.first<{ banned_at: number | null }>('SELECT banned_at FROM users WHERE id = ?', user);
  if (!owner || owner.banned_at) return fail(403, 'This account can’t sign in.', 'banned');
  return json(200, await signedIn(deps(ctx), user, await issueSession(deps(ctx), user, device(req))));
};

// ------------------------------------------------------------------ sessions

const sessions: Handler = async (req, _p, ctx) => {
  const id = await who(req, ctx);
  if (!id) return fail(401, 'Sign in again.');
  if (id.guest) return json(200, { sessions: [] });
  const current = sessionId(bearer(req));
  const rows = await ctx.db.all<{ id: string; device: string; created_at: number; last_seen: number }>('SELECT id, device, created_at, last_seen FROM sessions WHERE user = ? ORDER BY last_seen DESC', id.user);
  return json(200, { sessions: rows.map((s) => ({ id: s.id, device: s.device, created: s.created_at, lastSeen: s.last_seen, current: s.id === current })) });
};

const revoke: Handler = async (req, p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const id = await who(req, ctx);
  if (!id || id.guest) return fail(401, 'Sign in again.');
  const r = await ctx.db.run('DELETE FROM sessions WHERE id = ? AND user = ?', p.id, id.user);
  return r.changes ? json(200, { revoked: true }) : fail(404, 'No such session.');
};

const logout: Handler = async (req, _p, ctx) => {
  if (!originAllowed(req, ctx.env)) return fail(403, 'Not from this site.');
  const sid = sessionId(bearer(req));
  if (sid) await ctx.db.run('DELETE FROM sessions WHERE id = ?', sid);
  return json(200, { signedOut: true });
};

export const AUTH_ROUTES: Route[] = [
  { method: 'POST', path: '/api/auth/passkey/register/options', handler: registerOptions },
  { method: 'POST', path: '/api/auth/passkey/register/verify', handler: registerVerify },
  { method: 'POST', path: '/api/auth/passkey/login/options', handler: loginOptions },
  { method: 'POST', path: '/api/auth/passkey/login/verify', handler: loginVerify },
  { method: 'POST', path: '/api/auth/oauth/:provider/start', handler: oauthStart },
  { method: 'GET', path: '/api/auth/oauth/:provider/callback', handler: oauthCallback },
  { method: 'POST', path: '/api/auth/oauth/:provider/callback', handler: oauthCallback },
  { method: 'POST', path: '/api/auth/claim', handler: claim },
  { method: 'POST', path: '/api/auth/email/start', handler: emailStart },
  { method: 'POST', path: '/api/auth/email/verify', handler: emailVerify },
  { method: 'GET', path: '/api/auth/sessions', handler: sessions },
  { method: 'DELETE', path: '/api/auth/sessions/:id', handler: revoke },
  { method: 'POST', path: '/api/auth/logout', handler: logout },
];
