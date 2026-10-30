import { readFileSync } from 'node:fs';
import { embed, rankByCosine } from '@pactovio/models';
const env = { NEBIUS_API_KEY: process.env.NEBIUS_API_KEY } as never;
const rows = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { title: string; text: string }[];
const ev = (await embed(rows.map((r) => r.text), { env, role: 'embed', purpose: 'calibrate chunks' })).map((v) => v.slice(0, 1024));
const chunks = rows.map((r, i) => ({ title: r.title, embedding: ev[i]! }));
const qs = [
  'Tenderer must hold current ISO 27001 certification covering the services.',
  'Provide business continuity and disaster recovery arrangements for hosted applications.',
  'Describe your approach to take-on of the applications from the incumbent supplier.',
  'Tenderer must demonstrate experience supporting and developing GIS-enabled web applications using ArcGIS Enterprise and geodatabases.',
  'Provide the annual penetration test report for the hosted applications.',
  'Out-of-hours support 24x7 on-call cover during the grazing season for PastureBase Ireland.',
  'Describe your environmental considerations and carbon reduction measures.',
  'The Tenderer must provide a rate card for project manager, senior developer and junior developer.',
];
const qv = (await embed(qs, { env, role: 'embed', purpose: 'calibrate' })).map((v) => v.slice(0, 1024));
qv.forEach((v, i) => console.log(qs[i]!.slice(0, 70), '=>', rankByCosine(v, chunks.map((c) => ({ item: c, embedding: c.embedding })), 3).map((x) => `${x.score.toFixed(3)} ${x.item.title.slice(0, 38)}`).join(' | ')));
