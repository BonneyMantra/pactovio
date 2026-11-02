import { HttpError } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

/** Connector test/agent inputs must never upload another customer's R2 object. */
export async function requireOwnedFile(env: Env, workspace: string, key: string): Promise<void> {
  if (key.startsWith(`filled/${workspace}/`) && !key.includes('..')) return;
  const owned = await env.DB.prepare(`SELECT id FROM documents WHERE workspace_id = ? AND (r2_key = ? OR text_r2_key = ?)
    UNION SELECT id FROM evidence WHERE workspace_id = ? AND r2_key = ? LIMIT 1`).bind(workspace, key, key, workspace, key).first();
  if (!owned) throw new HttpError(404, 'File not found', 'not_found');
}
