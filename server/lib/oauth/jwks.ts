// A JWKS cache: fetches a provider's signing keys, keeps them for the Cache-Control max-age (clamped to
// 5 minutes .. 24 hours, 1 hour when absent), refetches early when a token names a key id it hasn't
// seen (keys rotate) at most once a minute, and keeps serving stale keys if a refetch fails.

import { importJwk, type JwtAlg } from '../crypto';

interface Entry {
  keys: JsonWebKey[];
  fetchedAt: number;
  expires: number;
  imported: Map<string, CryptoKey>;
}

export interface JwksFetchOptions {
  fetch?: typeof fetch;
  now?: number;
}

const MIN_MAX_AGE = 5 * 60_000;
const MAX_MAX_AGE = 24 * 3600_000;
const DEFAULT_MAX_AGE = 3600_000;
const REFETCH_GAP = 60_000;

function maxAge(header: string | null): number {
  const m = header ? /(?:^|,)\s*max-age=(\d+)/i.exec(header) : null;
  if (!m) return DEFAULT_MAX_AGE;
  return Math.min(MAX_MAX_AGE, Math.max(MIN_MAX_AGE, Number(m[1]) * 1000));
}

type KeyWithMeta = JsonWebKey & { kid?: string; use?: string };

export class JwksCache {
  private entries = new Map<string, Entry>();
  /** How many times the network was asked (tests). */
  fetches = 0;

  private async load(url: string, options: JwksFetchOptions, now: number): Promise<Entry> {
    this.fetches++;
    const response = await (options.fetch ?? fetch)(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`JWKS fetch failed (${response.status})`);
    const body = (await response.json()) as { keys?: unknown };
    if (!body || !Array.isArray(body.keys)) throw new Error('JWKS response has no keys');
    const entry: Entry = {
      keys: body.keys.filter((k): k is JsonWebKey => typeof k === 'object' && k !== null),
      fetchedAt: now,
      expires: now + maxAge(response.headers.get('Cache-Control')),
      imported: new Map(),
    };
    this.entries.set(url, entry);
    return entry;
  }

  private find(entry: Entry, kid: string | undefined, alg: JwtAlg): KeyWithMeta | undefined {
    const kty = alg === 'ES256' ? 'EC' : 'RSA';
    const usable = (entry.keys as KeyWithMeta[]).filter(
      (k) => k.kty === kty && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === alg),
    );
    if (kid !== undefined) return usable.find((k) => k.kid === kid);
    return usable.length === 1 ? usable[0] : undefined;
  }

  /** The verification key for `kid` at `url`, or null when the provider doesn't publish it. */
  async getKey(url: string, kid: string | undefined, alg: JwtAlg, options: JwksFetchOptions = {}): Promise<CryptoKey | null> {
    const now = options.now ?? Date.now();
    let entry = this.entries.get(url);
    if (!entry || now >= entry.expires) {
      try {
        entry = await this.load(url, options, now);
      } catch (e) {
        if (!entry) throw e;
        // Stale keys beat no keys while the provider is unreachable.
      }
    }
    let jwk = this.find(entry, kid, alg);
    if (!jwk && now - entry.fetchedAt >= REFETCH_GAP) {
      try {
        entry = await this.load(url, options, now);
        jwk = this.find(entry, kid, alg);
      } catch {
        // keep the current entry
      }
    }
    if (!jwk) return null;
    const cacheKey = `${alg}|${jwk.kid ?? ''}`;
    let key = entry.imported.get(cacheKey);
    if (!key) {
      key = await importJwk(jwk, alg, 'verify');
      entry.imported.set(cacheKey, key);
    }
    return key;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The process-wide cache the OAuth helpers use unless given another. */
export const sharedJwks = new JwksCache();
