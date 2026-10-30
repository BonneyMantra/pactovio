import { verifyDecision, type Decision } from '@pactovio/agent';
import type { PendingAction } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { hubFetch } from '../do/client';
import type { Router } from '../lib/router';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pactovio</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">${body}`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
const secretOf = (env: Env) => env.WEBHOOK_SIGNING_SECRET ?? (env.ENVIRONMENT === 'development' ? 'dev-webhook-signing' : undefined);

/**
 * Approve/decline links posted to Slack and Teams with a proactive message. The link is signed (HMAC over workspace,
 * action and decision). GET only shows a confirm button (link previews and scanners must not decide); POST decides.
 */
export function mountActionLinks(r: Router): void {
  const resolve = async (env: Env, id: string, q: { w?: string; d?: string; t?: string }) => {
    const secret = secretOf(env);
    const d = q.d === 'confirm' || q.d === 'decline' ? (q.d as Decision) : null;
    if (!secret || !q.w || !d || !q.t || !(await verifyDecision(secret, q.w, id, d, q.t))) return null;
    return { workspaceId: q.w, decision: d };
  };

  r.app.get('/agent/actions/:id/link', async (c) => {
    const id = c.req.param('id');
    const v = await resolve(c.env, id, c.req.query());
    if (!v) return page('<h2>Link not valid</h2><p>This approval link is invalid or has been altered.</p>', 403);
    const res = await hubFetch(c.env, { workspaceId: v.workspaceId, sessionId: null }, `/actions/${encodeURIComponent(id)}`);
    if (!res.ok) return page('<h2>Not found</h2><p>This request no longer exists.</p>', 404);
    const a = (await res.json()) as PendingAction;
    if (a.status !== 'pending') return page(`<h2>Already ${esc(a.status)}</h2><p>${esc(a.title ?? a.tool)}</p>`);
    const verb = v.decision === 'confirm' ? 'Approve' : 'Decline';
    return page(`<h2>${esc(a.title ?? a.tool)}</h2><p>${esc(a.detail ?? a.summary)}</p><form method="post" action="${esc(new URL(c.req.url).pathname + new URL(c.req.url).search)}"><button style="font-size:1rem;padding:.6rem 1.2rem">${verb}</button></form>`);
  });

  r.app.post('/agent/actions/:id/link', async (c) => {
    const id = c.req.param('id');
    const v = await resolve(c.env, id, c.req.query());
    if (!v) return page('<h2>Link not valid</h2>', 403);
    const res = await hubFetch(c.env, { workspaceId: v.workspaceId, sessionId: null }, `/actions/${encodeURIComponent(id)}`, { body: { decision: v.decision, trusted: true } });
    const data = (await res.json().catch(() => ({}))) as PendingAction & { error?: string };
    if (!res.ok) return page(`<h2>${res.status === 409 ? 'Already decided' : 'Could not complete'}</h2><p>${esc(data.error ?? 'Try again from Pactovio.')}</p>`, res.status === 409 ? 200 : res.status);
    return page(`<h2>${data.status === 'declined' ? 'Declined' : data.status === 'failed' ? 'Approved, but it failed' : 'Approved'}</h2><p>${esc(data.title ?? data.tool)}</p><p>You can close this tab.</p>`);
  });
}
