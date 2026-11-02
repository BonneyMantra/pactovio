import type { Env } from '@pactovio/contracts/env';
import { sha256Hex } from './db';

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * With Composio callback identity verification on, the browser returns to the project verifier URL with only
 * `?session_uri=`. The pending attempt is identified from the signed-in session plus the HttpOnly cookie each flow set
 * (`pv_integration_oauth` for universal integrations, `pv_oauth` for legacy connectors). If both cookies name a live
 * attempt of this session, the most recently started one (latest expiry) wins; the other stays pending until it expires.
 */
export async function pendingOAuthFlow(env: Env, session: string, universal: string | undefined, legacy: string | undefined): Promise<'universal' | 'legacy' | null> {
  const now = Date.now();
  const u = universal && HEX64.test(universal) ? await env.DB.prepare(`SELECT expires_at FROM integration_oauth_states
    WHERE state_hash = ? AND session_id = ? AND consumed_at IS NULL AND expires_at > ?`).bind(await sha256Hex(universal), session, now).first<{ expires_at: number }>() : null;
  const l = legacy && HEX64.test(legacy) ? await env.DB.prepare(`SELECT expires_at FROM connector_oauth_states
    WHERE state_hash = ? AND session_id = ? AND consumed_at IS NULL AND expires_at > ?`).bind(await sha256Hex(legacy), session, now).first<{ expires_at: number }>() : null;
  if (u && l) return u.expires_at >= l.expires_at ? 'universal' : 'legacy';
  return u ? 'universal' : l ? 'legacy' : null;
}
