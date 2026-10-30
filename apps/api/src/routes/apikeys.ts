import { endpoints, HttpError, newId, type ApiKey } from '@pactovio/contracts';
import { exec, nowIso, one, randomToken, rows, sha256Hex } from '../lib/db';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.listApiKeys, async ({ db, workspaceId }) => ({
    items: await rows<ApiKey>(db, 'SELECT id, workspace_id, prefix, name, created_at, last_used_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC', workspaceId),
  }));
  r.on(endpoints.createApiKey, async ({ db, workspaceId, body }) => {
    const key = `pk_${randomToken(20)}`;
    const id = newId('apiKey');
    const prefix = key.slice(0, 11);
    await exec(db, 'INSERT INTO api_keys (id, workspace_id, prefix, hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, workspaceId, prefix, await sha256Hex(key), body.name, nowIso());
    return { id, prefix, name: body.name, key };
  });
  r.on(endpoints.revokeApiKey, async ({ db, workspaceId, params }) => {
    const k = await one(db, 'SELECT id FROM api_keys WHERE id = ? AND workspace_id = ?', params.id, workspaceId);
    if (!k) throw new HttpError(404, 'API key not found', 'not_found');
    await exec(db, 'DELETE FROM api_keys WHERE id = ?', params.id);
    return { ok: true };
  });
};
