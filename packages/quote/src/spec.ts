import { chat, type CallOptions } from '@pactovio/models';
import { extractPack } from '@pactovio/pack';
import type { Env } from '@pactovio/contracts/env';

export type SpecInput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; bytes: Uint8Array; mime: string }
  | { kind: 'pdf'; r2Key: string; intakeId: string };

const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Turn a customer's spec (pasted text, a PDF in R2, or a photographed/scanned image) into plain text. Images go to Super VL. */
export async function parseSpec(env: Env, input: SpecInput, o: Omit<CallOptions, 'env' | 'purpose'> = {}): Promise<string> {
  if (input.kind === 'text') return input.text.trim();
  if (input.kind === 'pdf') {
    const pack = await extractPack(env, { intakeId: input.intakeId, r2Keys: [input.r2Key] });
    return pack.docs.flatMap((d) => d.pages.map((pg) => pg.text)).join('\n\n').trim();
  }
  const res = await chat({
    ...o, env, role: 'agent', purpose: 'read spec image', maxTokens: 3000, temperature: 0,
    messages: [
      { role: 'system', content: 'You transcribe customer technical specifications from images. Output the full text faithfully, keeping every number, unit and requirement. Do not summarise.' },
      { role: 'user', content: [
        { type: 'text', text: 'Transcribe this specification document.' },
        { type: 'image_url', image_url: { url: `data:${input.mime};base64,${b64(input.bytes)}` } },
      ] as unknown as string },
    ],
  });
  return res.text.trim();
}
