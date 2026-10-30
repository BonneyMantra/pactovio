import { endpoints, HttpError } from '@pactovio/contracts';
import type { Register } from '../lib/router';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const register: Register = (r) => {
  // Public (no session): the Nebius audit job authenticates with the shared secret header.
  r.on(endpoints.ingestAudit, async ({ c, env }) => {
    const secret = env.INGEST_SECRET;
    const given = c.req.header('x-ingest-secret') ?? '';
    if (!secret || !safeEqual(given, secret)) throw new HttpError(401, 'Invalid ingest secret', 'unauthorized');
    // audit lane: validate body, update audits row, emit audit.completed
    return c.json({ error: 'audit ingest is not implemented yet', code: 'not_implemented' }, 501);
  });
  r.stub(endpoints.getAudit, 'audit read');
};
