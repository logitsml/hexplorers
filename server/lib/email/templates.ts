// The two emails the server sends, as plain text plus a simple HTML version (inline styles only, one
// column, no images, no tracking). Every interpolated value is escaped for HTML and stripped of
// control characters; subjects are kept to one line.

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** Extra headers (List-Unsubscribe for notifications). */
  headers?: Record<string, string>;
}

/** Escape text for HTML element content and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Remove control and bidi-override characters; collapse to one line when `oneLine`. */
export function cleanText(text: string, oneLine = false): string {
  // eslint-disable-next-line no-control-regex
  let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '');
  if (oneLine) out = out.replace(/[\r\n\t]+/g, ' ').trim();
  return out;
}

function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('email: links must be http(s)');
  return parsed.toString();
}

function layout(title: string, bodyHtml: string, footer: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f3ead6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3ead6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fffaf0;border:1px solid #d9c7a0;border-radius:12px;">
<tr><td style="padding:28px 28px 8px;font-family:Georgia,'Times New Roman',serif;color:#1f3347;">
<p style="margin:0 0 4px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#8a6d3b;">Hexplorers</p>
${bodyHtml}
</td></tr>
<tr><td style="padding:8px 28px 24px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#7a7364;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#1f3347;color:#fffaf0;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;padding:12px 22px;border-radius:8px;">${escapeHtml(label)}</a></p>`;
}

export interface SignInEmailInput {
  /** The magic link (its token belongs in the URL fragment). */
  url: string;
  /** The 6-digit code for signing in on another device. */
  code?: string;
  minutes?: number;
}

/** "Your sign-in link". */
export function signInEmail(input: SignInEmailInput): RenderedEmail {
  const url = safeUrl(input.url);
  const minutes = input.minutes ?? 15;
  const code = input.code && /^\d{6}$/.test(input.code) ? input.code : undefined;
  const subject = 'Your sign-in link';
  const text = [
    'Your sign-in link for Hexplorers:',
    '',
    url,
    '',
    ...(code ? [`Or enter this code on the device you're signing in on: ${code}`, ''] : []),
    `The link works once and expires in ${minutes} minutes.`,
    "If you didn't ask for it, you can ignore this email: nobody can sign in without it.",
  ].join('\n');
  const html = layout(
    subject,
    `<h1 style="margin:0 0 12px;font-size:24px;font-weight:normal;">Your sign-in link</h1>
<p style="margin:0;font-size:16px;line-height:24px;">Press the button to sign in to Hexplorers.</p>
${button(url, 'Sign in')}
${code ? `<p style="margin:0 0 8px;font-size:15px;line-height:22px;">Or enter this code on the device you're signing in on:</p>
<p style="margin:0 0 16px;font-family:'Courier New',monospace;font-size:28px;letter-spacing:6px;">${escapeHtml(code)}</p>` : ''}`,
    `The link works once and expires in ${minutes} minutes. If you didn't ask for it, you can ignore this email: nobody can sign in without it.`,
  );
  return { subject, text, html };
}
