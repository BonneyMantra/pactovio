import { Sql } from './seed-lib';
import { seedCompanies } from './seed-companies';
import { seedTenders } from './seed-tenders';
import { seedTeagasc } from './seed-teagasc';
import { seedKestrel } from './seed-kestrel';

export function buildSeed(): string {
  const s = new Sql();
  seedCompanies(s);
  seedTenders(s);
  seedTeagasc(s);
  seedKestrel(s);
  return s.toString();
}

