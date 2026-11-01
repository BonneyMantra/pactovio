import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { SAMPLE_USER_ID } from './catalog';

export async function workspaceUserId(env: Env, workspace: string): Promise<string> {
  const row = await env.DB.prepare('SELECT sample FROM workspaces WHERE id = ?').bind(workspace).first<{ sample: number }>();
  if (!row) throw new HttpError(404, 'Workspace not found', 'not_found');
  return row.sample ? SAMPLE_USER_ID : `pactovio-workspace-${workspace}`;
}
export async function tokenHash(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}
export function stateToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, '0')).join('');
}
export const safeReturn = (to?: string): string => to === '/app#/onboarding' ? to : '/app#/connections';
