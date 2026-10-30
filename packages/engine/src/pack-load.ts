import { HttpError, NotImplemented, PackText } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { extractPack } from '@pactovio/pack';
import { chat, type StepRecord } from '@pactovio/models';
import type { ChatMessage } from '@pactovio/models';

/** Fixture location for packs lane A has not extracted (built by scripts/build-fixture.ts). */
export const packFixtureKey = (tenderId: string) => `fixtures/packtext/${tenderId}.json`;

/** PackText from lane A's extractPack; falls back to a stored fixture while that lane is incomplete. */
export async function loadPackText(env: Env, tenderId: string): Promise<{ pack: PackText; source: 'pack' | 'fixture' }> {
  const docs = await env.DB.prepare('SELECT r2_key FROM documents WHERE tender_id = ?').bind(tenderId).all<{ r2_key: string }>();
  try {
    const pack = PackText.parse(await extractPack(env, { tenderId, r2Keys: docs.results.map((d) => d.r2_key) }));
    if (pack.docs.some((d) => d.pages.length)) return { pack, source: 'pack' };
  } catch (e) {
    if (!(e instanceof NotImplemented)) console.error('engine: extractPack failed, trying fixture', e instanceof Error ? e.message : e);
  }
  const obj = await env.FILES.get(packFixtureKey(tenderId));
  if (!obj) throw new HttpError(404, 'No extracted text for this tender pack yet', 'not_found');
  return { pack: PackText.parse(await obj.json()), source: 'fixture' };
}

const b64 = (buf: ArrayBuffer): string => Buffer.from(buf).toString('base64');
const mimeOf = (key: string) => (/\.jpe?g$/i.test(key) ? 'image/jpeg' : /\.webp$/i.test(key) ? 'image/webp' : 'image/png');

export const MAX_VISION_IMAGES = 6;

/** Super VL reads one image of the pack (drawing, scan, screenshot) and returns what matters for a bid. */
export async function readImage(
  env: Env,
  o: { r2Key: string; filename: string; onStep?: (s: StepRecord) => void | Promise<void>; fetch?: typeof fetch },
): Promise<string> {
  const obj = await env.FILES.get(o.r2Key);
  if (!obj) return '';
  const data = b64(await obj.arrayBuffer());
  const prompt = `This image belongs to a tender pack (file: ${o.filename}). Transcribe the visible text and describe what it shows that a bidder must know: components and tiers, hosting and environments, technology stack, integrations and data flows, constraints. Plain bullet list, no preamble, every label exactly as printed.`;
  const msg = { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mimeOf(o.r2Key)};base64,${data}` } }] } as unknown as ChatMessage;
  const res = await chat({
    env, role: 'agent', purpose: `Read image: ${o.filename}`, messages: [msg], maxTokens: 1800, onStep: o.onStep, fetch: o.fetch,
    extra: { chat_template_kwargs: { enable_thinking: false } },
  });
  return res.text;
}

export interface BuiltPrompt { text: string; docs: { docId: string; filename: string }[] }

/** The pack as one stable block. It always comes FIRST in every prompt of the run so the provider can cache the prefix. */
export function buildPackBlock(pack: PackText, vision: Record<string, string> = {}): BuiltPrompt {
  const docs = [...pack.docs].sort((a, b) => a.filename.localeCompare(b.filename));
  const parts: string[] = ['<tender_pack>'];
  for (const d of docs) {
    parts.push(`=== DOCUMENT: ${d.filename}${d.isForm ? ' (the tenderer response form)' : ''} ===`);
    for (const p of d.pages) parts.push(`[page ${p.n}]\n${p.text}`);
    if (vision[d.docId]) parts.push(`[image read by a vision model]\n${vision[d.docId]}`);
  }
  parts.push('</tender_pack>');
  return { text: parts.join('\n'), docs: docs.map((d) => ({ docId: d.docId, filename: d.filename })) };
}
