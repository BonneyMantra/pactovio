import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { chat, chatJSON, embed } from '@pactovio/models';
const env = { NEBIUS_API_KEY: process.env.NEBIUS_API_KEY } as never;
const which = process.argv[2];
const log = (s: unknown) => process.stderr.write(JSON.stringify(s) + '\n');
const onStep = (s: unknown) => log({ step: s });
if (which === 'ultra') {
  const S = z.object({ items: z.array(z.object({ ref: z.string(), kind: z.enum(['mandatory', 'scored', 'info']) })) });
  const r = await chatJSON(S, { env, purpose: 'probe', role: 'reason', onStep, maxTokens: 800, messages: [{ role: 'user', content: 'List 2 requirements from: "A1 Tenderer must hold ISO 27001 (mandatory). B1 Describe your take-on plan (scored 35%)." Return JSON.' }], extra: process.argv[3] === 'nothink' ? { chat_template_kwargs: { enable_thinking: false } } : {} });
  log({ data: r.data });
}
if (which === 'embed') {
  const v = await embed(['ISO 27001 certificate', 'turnover'], { env, purpose: 'probe', role: 'embed', onStep });
  log({ dims: v[0]!.length, sample: v[0]!.slice(0, 3) });
}
if (which === 'vl') {
  const b64 = readFileSync('../../fixtures/packs/ie-teagasc-695163/NMP Architecture diagram P4941 LOT2.png').toString('base64');
  const r = await chat({ env, purpose: 'probe vl', role: 'agent', model: process.argv[3], onStep, maxTokens: 900, extra: { chat_template_kwargs: { enable_thinking: false } }, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this architecture diagram: list components, hosting and integrations. Be concise.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] as never }] });
  log({ text: r.text.slice(0, 1500) });
}
