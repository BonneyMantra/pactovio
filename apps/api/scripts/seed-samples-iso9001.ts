import { writeFileSync } from 'node:fs';
import { iso9001 } from '@pactovio/quote/samples';

/** Writes the ISO 9001 certificate PDF that seed-samples-scan.py rasterises into the scanned PNG. Usage: tsx scripts/seed-samples-iso9001.ts <out.pdf> */
iso9001().then((d) => writeFileSync(process.argv[2]!, d.bytes));
