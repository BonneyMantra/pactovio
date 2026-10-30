import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSeed } from './seed-build';

// Run from apps/api (npm run seed:local). Writes .seed.sql (gitignored).
const out = resolve(process.cwd(), '.seed.sql');
writeFileSync(out, buildSeed());
process.stderr.write(`seed written: ${out}\n`);
