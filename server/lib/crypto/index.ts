// server/lib/crypto: the small cryptographic toolkit the other server libraries share.
//
// Web standard APIs only (crypto.subtle, crypto.getRandomValues, TextEncoder, btoa/atob), so it runs
// unchanged on Node and on Cloudflare Workers. Nothing here logs.
//
//   bytes:  utf8 / fromUtf8, toBase64 / toBase64Url / fromBase64Url, toHex / fromHex, concat,
//           timingSafeEqual, randomBytes, randomId
//   hash:   sha256 / sha256Hex, hmacSha256 / hmacSha256Hex / hmacVerify, hkdf (RFC 5869)
//   token:  signToken(payload, secret, ttlMs, {purpose}) / verifyToken(token, secret, {purpose})
//           -> { ok, payload, exp } | { ok: false, reason: 'malformed' | 'signature' | 'expired' }
//   jwt:    decodeJwt, signJwt, verifyJwtSignature (ES256, RS256; the caller fixes the alg),
//           importJwk, importPkcs8Pem, derToRawEcdsa / rawToDerEcdsa
//
// Example:
//   const t = await signToken({ user: 'u1' }, env.TOKEN_SECRET, 15 * 60_000, { purpose: 'magic' });
//   const r = await verifyToken<{ user: string }>(t, env.TOKEN_SECRET, { purpose: 'magic' });
//   if (r.ok) r.payload.user;

export * from './bytes';
export * from './hash';
export * from './token';
export * from './jwt';
