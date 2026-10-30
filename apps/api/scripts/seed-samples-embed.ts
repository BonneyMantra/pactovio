import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '@pactovio/contracts/env';
import { embedDatasheets } from '@pactovio/quote';

/**
 * Embeds the Kestrel datasheet lines (256-dim Qwen3-Embedding, ~3 live requests) into a local D1 state and optionally
 * writes the vectors as SQL for the remote database. Stop any wrangler dev on the same state first.
 *   tsx scripts/seed-samples-embed.ts <persist-dir>/v3 [--emit-sql .wrangler/seed-samples-embeddings.sql]
 *   bash ./cf.sh d1 execute pactovio --remote --file=.wrangler/seed-samples-embeddings.sql
 */
const [persist, flag, sqlOut] = process.argv.slice(2);
if (!persist) throw new Error('usage: <persist-dir>/v3 [--emit-sql out.sql]');
const proxy = await getPlatformProxy<Env>({ configPath: resolve(process.cwd(), 'wrangler.toml'), persist: { path: resolve(process.cwd(), persist) } });
const env = proxy.env as Env;
const n = await embedDatasheets(env, 'ws_kestrel_sensing', { batch: 64, onStep: (s) => { process.stderr.write(`step ${s.purpose} ${s.status} ${s.ms}ms ${s.summary ?? ''}\n`); } });
process.stderr.write(`embedded ${n} lines\n`);
if (flag === '--emit-sql' && sqlOut) {
  const rows = (await env.DB.prepare("SELECT c.id, c.embedding_json FROM evidence_chunks c JOIN evidence e ON e.id = c.evidence_id WHERE e.kind = 'datasheet' AND c.workspace_id = 'ws_kestrel_sensing' AND c.embedding_json IS NOT NULL").all<{ id: string; embedding_json: string }>()).results;
  writeFileSync(sqlOut, `${rows.map((r) => `UPDATE evidence_chunks SET embedding_json = '${r.embedding_json}' WHERE id = '${r.id}';`).join('\n')}\n`);
  process.stderr.write(`wrote ${rows.length} UPDATEs to ${sqlOut}\n`);
}
await proxy.dispose();
