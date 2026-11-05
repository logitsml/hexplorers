import { describe, expect, it } from 'vitest';
import { moved } from '../server/cloudflare/worker';
import type { WorkerEnv } from '../server/cloudflare/types';

const env = { PUBLIC_URL: 'https://hexplorers.xyz', REDIRECT_HOSTS: 'www.hexplorers.xyz, old.example' } as WorkerEnv;
const at = (href: string) => moved(new URL(href), env);

describe("the game's former addresses", () => {
  it('move their pages to the same path at the public address', () => {
    const r = at('https://old.example/r/KQ7M4P?from=Marlow')!;
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://hexplorers.xyz/r/KQ7M4P?from=Marlow');
    expect(at('https://WWW.hexplorers.xyz/')!.headers.get('location')).toBe('https://hexplorers.xyz/');
  });
  it('answer the service worker kill switch and keep their API', async () => {
    const off = at('https://old.example/sw-off')!;
    expect(off.status).toBe(200);
    expect(off.headers.get('content-type')).toBe('text/plain');
    expect(at('https://old.example/api/guest')).toBeNull();
  });
  it('leave the public address alone', () => {
    expect(at('https://hexplorers.xyz/r/KQ7M4P')).toBeNull();
    expect(at('https://hexplorers.xyz/sw-off')).toBeNull();
  });
});
