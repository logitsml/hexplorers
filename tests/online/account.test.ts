import { afterEach, describe, expect, it } from 'vitest';
import { profileFrom, profilePath } from '../../src/online/links';
import { refresh, setFetch, signOut, useAccount } from '../../src/online/account';
import { loadIdentity, saveIdentity } from '../../src/online/identity';

/** localStorage as a Map (node has none). */
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) },
});

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  store.clear();
  useAccount.setState({ me: null, sheet: null, viewing: null, note: null });
});

describe('profile links', () => {
  it('reads /u/HANDLE and the 404 page’s ?go=/u/HANDLE, and nothing else', () => {
    expect(profileFrom({ pathname: '/u/Marlow', search: '' })).toBe('Marlow');
    expect(profileFrom({ pathname: '/u/@amber_gannet/', search: '' })).toBe('amber_gannet');
    expect(profileFrom({ pathname: '/', search: '?go=%2Fu%2FMarlow' })).toBe('Marlow');
    expect(profileFrom({ pathname: '/u/no', search: '' })).toBeNull();
    expect(profileFrom({ pathname: '/u/has space', search: '' })).toBeNull();
    expect(profileFrom({ pathname: '/r/BCDFGH', search: '' })).toBeNull();
    expect(profilePath('Marlow')).toBe('/u/Marlow');
  });
});

describe('the account, from the client', () => {
  it('looks at the register without making a guest, and follows a handle changed elsewhere', async () => {
    const calls: string[] = [];
    setFetch((async (url: string) => (calls.push(url), json({}))) as unknown as typeof fetch);
    const me = await refresh();
    expect(me).toMatchObject({ guest: true, played: 0 });
    expect(calls).toEqual([]);
    saveIdentity({ user: 'g_1', token: 'xa1.s', name: 'Marlow', guest: false, handle: 'Old' });
    setFetch((async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer xa1.s');
      return json({ user: 'g_1', name: 'Marlow', handle: 'New', guest: false, played: 3, won: 1, recent: [] });
    }) as unknown as typeof fetch);
    expect((await refresh())?.handle).toBe('New');
    expect(loadIdentity()?.handle).toBe('New');
  });

  it('comes back as a guest when the session was revoked, and when signing out', async () => {
    saveIdentity({ user: 'g_1', token: 'xa1.gone', name: 'Marlow', guest: false, handle: 'Marlow' });
    setFetch((async () => json({ error: 'Sign in again.' }, 401)) as unknown as typeof fetch);
    expect(await refresh()).toMatchObject({ guest: true });
    expect(loadIdentity()).toBeNull();
    saveIdentity({ user: 'g_2', token: 'xa1.live', name: 'Wren', guest: false, handle: 'Wren' });
    const asked: string[] = [];
    setFetch((async (url: string, init: RequestInit) => (asked.push(`${init.method} ${url}`), json({ signedOut: true }))) as unknown as typeof fetch);
    await signOut();
    expect(asked).toEqual(['POST /api/auth/logout']);
    expect(loadIdentity()).toBeNull();
    expect(useAccount.getState().me).toMatchObject({ guest: true });
  });
});
