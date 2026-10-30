import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { toRow } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import type { PackSpec } from './seed-packs-manifest';

const q = (v: string | number | null): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);
const log = (m: string) => process.stderr.write(`${m}\n`);

/** Copy what the local extraction produced (R2 objects, documents rows, tender link) to production D1 and R2. */
export async function pushRemote(env: Env, o: { apiDir: string; owners: PackSpec[]; dry: boolean }): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'pactovio-seed-remote-'));
  const sql: string[] = [];
  const keys = new Set<string>();
  for (const p of o.owners) {
    const rows = (await env.DB.prepare('SELECT * FROM documents WHERE tender_id = ?').bind(p.tenderId).all<Record<string, unknown>>()).results;
    sql.push(
      `UPDATE tenders SET url = ${q(`https://${p.host}/epps/cft/prepareViewCfTWS.do?resourceId=${p.resourceId}`)}, raw_json = json_patch(COALESCE(raw_json, '{}'), json_object('resource_id', ${q(p.resourceId)}, 'portal', ${q(p.host)})) WHERE id = ${q(p.tenderId)};`,
    );
    // Stale sample placeholders (no real file, not referenced by requirements) go after the real rows land.
    const drop = `DELETE FROM documents WHERE tender_id = ${q(p.tenderId)} AND id LIKE 'doc_sample_%' AND r2_key LIKE 'tenders/%' AND id NOT IN (SELECT doc_id FROM requirements WHERE doc_id IS NOT NULL);`;
    for (const r of rows) {
      const row = toRow(r);
      const cols = Object.keys(row);
      sql.push(`INSERT INTO documents (${cols.join(', ')}) VALUES (${cols.map((c) => q(row[c]!)).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')};`);
      keys.add(String(r.r2_key));
      if (r.text_r2_key) keys.add(String(r.text_r2_key));
    }
    sql.push(drop);
  }
  log(`remote: ${keys.size} R2 objects, ${sql.length} SQL statements${o.dry ? ' (dry run, nothing sent)' : ''}`);
  if (o.dry) return;
  const cf = (...args: string[]) => execFileSync('bash', [resolve(o.apiDir, 'cf.sh'), ...args], { cwd: o.apiDir, stdio: ['ignore', 'ignore', 'inherit'] });
  let i = 0;
  for (const key of keys) {
    const obj = await env.FILES.get(key);
    if (!obj) continue;
    const f = join(tmp, `o${i++}`);
    writeFileSync(f, new Uint8Array(await obj.arrayBuffer()));
    cf('r2', 'object', 'put', `pactovio-files/${key}`, '--file', f, '--content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream', '--remote');
  }
  const sqlFile = join(tmp, 'packs.sql');
  writeFileSync(sqlFile, `${sql.join('\n')}\n`);
  cf('d1', 'execute', 'pactovio', '--remote', `--file=${sqlFile}`);
  log('remote: done');
}
