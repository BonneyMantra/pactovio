/** Sign-in code email: table layout with inline styles (email clients), no remote images, plain-text part kept. */
const ACCENT = '#f2600c';
const INK = '#1f1d1a';
const MUTED = '#6b655d';
const PAPER = '#faf8f5';

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface OtpEmail { subject: string; text: string; html: string }

export function otpEmail(code: string, opts: { email?: string; minutes?: number } = {}): OtpEmail {
  if (!/^\d{6}$/.test(code)) throw new Error('A six-digit code is required');
  const minutes = opts.minutes ?? 10;
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const to = opts.email ? escapeHtml(opts.email) : '';
  const subject = 'Your Pactovio sign-in code';
  const text = [
    `Your Pactovio sign-in code is ${code}.`,
    `It expires in ${minutes} minutes.${opts.email ? ` It was requested for ${opts.email}.` : ''}`,
    'If you did not request this code, you can ignore this email. Nobody can sign in without it.',
    '',
    'Pactovio - pactovio.pages.dev',
  ].join('\n');
  const font = "font-family:'Mona Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your sign-in code is ${code}. It expires in ${minutes} minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #ece7e0;border-radius:14px;">
<tr><td style="padding:32px 32px 8px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="28" height="28" style="width:28px;height:28px;background:${ACCENT};border-radius:7px;color:#ffffff;${font};font-size:16px;font-weight:700;text-align:center;line-height:28px;">P</td>
<td style="padding-left:10px;${font};font-size:18px;font-weight:700;color:${INK};letter-spacing:-0.2px;">Pactovio</td>
</tr></table></td></tr>
<tr><td style="padding:24px 32px 0 32px;${font};font-size:20px;font-weight:600;color:${INK};line-height:28px;">Your sign-in code</td></tr>
<tr><td style="padding:8px 32px 0 32px;${font};font-size:15px;color:${MUTED};line-height:22px;">Enter this code to continue${to ? ` as <span style="color:${INK};">${to}</span>` : ''}.</td></tr>
<tr><td style="padding:24px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" style="background:${PAPER};border:1px solid #ece7e0;border-radius:10px;padding:18px 12px;${font};font-size:34px;font-weight:700;letter-spacing:10px;color:${INK};">${spaced}</td>
</tr></table></td></tr>
<tr><td style="padding:0 32px;${font};font-size:14px;color:${MUTED};line-height:21px;">This code expires in ${minutes} minutes and can be used once.</td></tr>
<tr><td style="padding:12px 32px 32px 32px;${font};font-size:14px;color:${MUTED};line-height:21px;">If you didn't request this code, you can safely ignore this email. Nobody can sign in without it.</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td align="center" style="padding:20px 16px;${font};font-size:12px;color:${MUTED};line-height:18px;">Pactovio &middot; <a href="https://pactovio.pages.dev" style="color:${MUTED};text-decoration:underline;">pactovio.pages.dev</a></td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}
