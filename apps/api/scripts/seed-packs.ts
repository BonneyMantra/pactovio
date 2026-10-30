/**
 * Seed the real showcase packs: upload fixtures/packs/<slug>/ to R2 under packs/<tenderId>/ and run extractPack so
 * PackText (packs/<tenderId>/text.json) and real `documents` rows exist.
 *
 *   npx tsx scripts/seed-packs.ts [--state .wrangler/state] [--only <slug>]      local R2 + D1 (what `wrangler dev` reads)
 *   npx tsx scripts/seed-packs.ts --remote [--dry-run]                           extract locally, then push R2 objects and D1 rows to production
 *
 * Run from apps/api. Tenders must exist (npm run seed:local first; the script applies migrations and the sample seed when missing).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env } from '@pactovio/contracts/env';
import { extractPack, kindOf } from '@pactovio/pack';
import { buildSeed } from './seed-build';
import { PACKS, type PackSpec } from './seed-packs-manifest';
import { pushRemote } from './seed-packs-remote';

const flag = (name: string) => process.argv.includes(`--${name}`);
const value = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1] : undefined;
};
const remote = flag('remote');
const dry = flag('dry-run');
const only = value('only');
const apiDir = process.cwd();
const root = resolve(apiDir, '../../fixtures/packs');
const state = resolve(apiDir, remote ? '.wrangler/state-seed-packs' : (value('state') ?? '.wrangler/state'));
const log = (m: string) => process.stderr.write(`${m}\n`);

function cf(...args: string[]): string {
  return execFileSync('bash', [resolve(apiDir, 'cf.sh'), ...args], { cwd: apiDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Migrate and (when the tenders are missing) seed the target state with wrangler BEFORE the in-process proxy opens it. */
function prepareState(): void {
  cf('d1', 'migrations', 'apply', 'pactovio', '--local', '--persist-to', state);
  const out = cf('d1', 'execute', 'pactovio', '--local', '--persist-to', state, '--json', '--command', "SELECT COUNT(*) AS n FROM tenders WHERE id LIKE 'tnd_sample_%'");
  const n = (JSON.parse(out.slice(out.indexOf('['))) as { results: { n: number }[] }[])[0]?.results[0]?.n ?? 0;
  if (n > 0) return;
  const f = join(mkdtempSync(join(tmpdir(), 'pactovio-seed-')), 'seed.sql');
  writeFileSync(f, buildSeed());
  cf('d1', 'execute', 'pactovio', '--local', '--persist-to', state, `--file=${f}`);
  log('applied sample seed to the target state');
}

function filesOf(p: PackSpec): string[] {
  return p.files ?? readdirSync(join(root, p.slug)).filter((f) => kindOf(f) !== null).sort();
}

const DROP_STALE = "DELETE FROM documents WHERE tender_id = ? AND id LIKE 'doc_sample_%' AND r2_key LIKE 'tenders/%' AND id NOT IN (SELECT doc_id FROM requirements WHERE doc_id IS NOT NULL)";
const CT: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

async function main(): Promise<void> {
  mkdirSync(state, { recursive: true });
  prepareState();
  const proxy = await getPlatformProxy<Env>({ configPath: resolve(apiDir, 'wrangler.toml'), persist: { path: join(state, 'v3') } });
  const env = proxy.env as Env;
  try {
    for (const p of PACKS.filter((x) => !only || x.slug === only)) {
      if (!existsSync(join(root, p.slug))) { log(`skip ${p.slug}: fixtures/packs/${p.slug} missing`); continue; }
      const keys: string[] = [];
      for (const name of filesOf(p)) {
        const key = `packs/${p.tenderId}/${name}`;
        await env.FILES.put(key, readFileSync(join(root, p.slug, name)), { httpMetadata: { contentType: CT[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream' } });
        keys.push(key);
      }
      // Real tender link and eTenders resource id (the scan uses raw.resource_id to download packs).
      await env.DB.batch([
        env.DB.prepare("UPDATE tenders SET url = ?, raw_json = json_patch(COALESCE(raw_json, '{}'), json_object('resource_id', ?, 'portal', ?)) WHERE id = ?")
          .bind(`https://${p.host}/epps/cft/prepareViewCfTWS.do?resourceId=${p.resourceId}`, p.resourceId, p.host, p.tenderId),
      ]);
      const pack = await extractPack(env, { tenderId: p.tenderId, r2Keys: keys });
      // Sample placeholder rows that no real file replaced and nothing references (their r2 objects never existed).
      await env.DB.prepare(DROP_STALE).bind(p.tenderId).run();
      const forms = pack.docs.filter((d) => d.isForm).length;
      const pages = pack.docs.reduce((a, d) => a + d.pages.length, 0);
      log(`${p.slug}: ${keys.length} files -> ${pack.docs.length} documents, ${pages} pages, ${forms} forms`);
    }
    if (remote) await pushRemote(env, { apiDir, owners: PACKS.filter((x) => !only || x.slug === only), dry });
  } finally {
    await proxy.dispose();
  }
}

main().catch((e) => {
  log(`seed-packs failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
});
