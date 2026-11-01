import { CompanyProfile } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { randomToken, sha256Hex } from '../src/lib/db';

/** Real persisted customer session for route tests; no auth bypass or production fixtures. */
export async function customerFixture(env: Env, workspace?: string) {
  const token = randomToken(32), id = `ses_${randomToken(12)}`, user = `usr_${randomToken(12)}`;
  const ws = workspace ?? `ws_${randomToken(12)}`, now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO workspaces (id, name, segment, profile_json, sample, created_at) VALUES (?, 'Meridian Instruments', 'industrial', ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET sample = 0`).bind(ws, JSON.stringify(CompanyProfile.parse({ legal_name: 'Meridian Instruments', hq: { city: 'Penang', country: 'MY' } })), now).run();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO customer_users (id, email, workspace_id, verified_at) VALUES (?, ?, ?, ?)').bind(user, `${user}@meridian.example`, ws, now),
    env.DB.prepare('INSERT INTO workspace_members (user_id, workspace_id) VALUES (?, ?)').bind(user, ws),
    env.DB.prepare('INSERT INTO customer_sessions (id, token_hash, user_id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, await sha256Hex(token), user, ws, Date.now(), Date.now() + 3600000),
    env.DB.prepare('INSERT INTO judge_sessions (id, workspace_id, created_at) VALUES (?, ?, ?)').bind(id, ws, now),
    env.DB.prepare('INSERT OR IGNORE INTO company_onboarding (workspace_id, updated_at) VALUES (?, ?)').bind(ws, now),
  ]);
  return { cookie: `pv_customer=${token}`, workspace: ws, user, session: id };
}
