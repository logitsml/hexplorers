// server/lib/email: magic-link sign-in emails, sent through Resend's HTTP API.
//
// Off unless RESEND_API_KEY and EMAIL_FROM are set (EMAIL_FROM like 'Hexplorers <post@exploratory.example>').
// Addresses are personal data: nothing here logs them, and no error carries one.
//
//   const link = await createMagicLink(email, env.TOKEN_SECRET);           // { token, code, nonce, exp, emailHash }
//   const mail = signInEmail({ url: magicLinkUrl(env.PUBLIC_URL, link.token), code: link.code });
//   const sent = await sendEmail(env, { to: email, ...mail });              // { ok, id } | { ok: false, error }
//   // later, from the link's fragment:
//   const r = await verifyMagicLink(token, env.TOKEN_SECRET, { consume: (nonce, exp) => markUsed(nonce, exp) });

import type { ServerEnv } from '../../core/ports';
import { cleanText } from './templates';

export * from './magic';
export * from './templates';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type EmailEnv = Pick<ServerEnv, 'RESEND_API_KEY' | 'EMAIL_FROM'>;

/** Whether email is on. */
export function isConfigured(env: EmailEnv): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

/** A cheap shape check (one @, a dot in the domain, no spaces or angle brackets, ≤ 254 characters). */
export function isPlausibleEmail(address: string): boolean {
  return typeof address === 'string' && address.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(address);
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  /** Resend tags (ASCII letters, digits, _ and -), e.g. [{ name: 'kind', value: 'magic' }]. */
  tags?: { name: string; value: string }[];
  /** Resend's Idempotency-Key: the same key within 24 h sends once. */
  idempotencyKey?: string;
}

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: 'not-configured' | 'invalid-address' | 'rejected' | 'unauthorized' | 'rate-limited' | 'server-error' | 'network'; status?: number };

/** Send one email. Never throws for delivery problems: the result says what happened. */
export async function sendEmail(env: EmailEnv, message: EmailMessage, deps: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<SendResult> {
  if (!isConfigured(env)) return { ok: false, error: 'not-configured' };
  if (!isPlausibleEmail(message.to)) return { ok: false, error: 'invalid-address' };
  const body = {
    from: env.EMAIL_FROM,
    to: [message.to],
    subject: cleanText(message.subject, true).slice(0, 200),
    text: message.text,
    html: message.html,
    ...(message.headers ? { headers: message.headers } : {}),
    ...(message.tags ? { tags: message.tags.filter((t) => /^[A-Za-z0-9_-]{1,256}$/.test(t.name) && /^[A-Za-z0-9_-]{1,256}$/.test(t.value)) } : {}),
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey.slice(0, 256);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(RESEND_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const status = response.status;
  if (response.ok) {
    const json = (await response.json().catch(() => null)) as { id?: unknown } | null;
    return { ok: true, id: typeof json?.id === 'string' ? json.id : '' };
  }
  // The error body may quote the address back: read it away, never return it.
  await response.body?.cancel().catch(() => undefined);
  if (status === 401 || status === 403) return { ok: false, error: 'unauthorized', status };
  if (status === 429) return { ok: false, error: 'rate-limited', status };
  if (status >= 500) return { ok: false, error: 'server-error', status };
  return { ok: false, error: 'rejected', status };
}
