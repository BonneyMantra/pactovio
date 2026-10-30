import type { Env } from '@pactovio/contracts/env';
import { buildHarbour, buildKestrel } from '../src/samples';
import { catalogSql, evidenceSql } from '../../../apps/api/scripts/seed-samples-sql';
import { designSql } from '../../../apps/api/scripts/seed-samples-design';
import { makeEnv } from '../../../apps/api/test/helpers';

/** Fresh migrated + foundation-seeded D1, plus this lane's sample evidence, catalogue and design requests. */
export async function makeSampleEnv(): Promise<{ env: Env; dispose: () => Promise<void> }> {
  const x = await makeEnv();
  const harbour = await buildHarbour(null);
  const kestrel = await buildKestrel();
  for (const s of [...evidenceSql([...harbour, ...kestrel]), ...catalogSql(kestrel), ...designSql()]) await x.env.DB.prepare(s).run();
  return x;
}

export const KESTREL = 'ws_kestrel_sensing';
