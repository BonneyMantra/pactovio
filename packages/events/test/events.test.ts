import { describe, expect, it } from 'vitest';
import { deriveWebhookSecret, emit, signWebhook, verifyWebhook } from '../src';
import type { Env } from '@pactovio/contracts/env';

describe('webhook signing', () => {
  const env = { WEBHOOK_SIGNING_SECRET: 'root', ENVIRONMENT: 'production' };
  it('derives stable, per-endpoint secrets', async () => {
    expect(await deriveWebhookSecret(env, 'whk_a')).toBe(await deriveWebhookSecret(env, 'whk_a'));
    expect(await deriveWebhookSecret(env, 'whk_a')).not.toBe(await deriveWebhookSecret(env, 'whk_b'));
  });
  it('refuses to run in production without a root secret', async () => {
    await expect(deriveWebhookSecret({ ENVIRONMENT: 'production' }, 'whk_a')).rejects.toThrow();
  });
  it('signs and verifies, rejecting tampering and stale timestamps', async () => {
    const h = await signWebhook('s3cret', '{"a":1}');
    expect(h).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(await verifyWebhook('s3cret', '{"a":1}', h)).toBe(true);
    expect(await verifyWebhook('s3cret', '{"a":2}', h)).toBe(false);
    expect(await verifyWebhook('other', '{"a":1}', h)).toBe(false);
    expect(await verifyWebhook('s3cret', '{"a":1}', await signWebhook('s3cret', '{"a":1}', 1000))).toBe(false);
  });
});

describe('emit', () => {
  it('writes the event, enqueues it, notifies the DO, and never throws', async () => {
    const sent: unknown[] = [];
    const inserted: unknown[][] = [];
    const notified: string[] = [];
    const env = {
      DB: { prepare: () => ({ bind: (...a: unknown[]) => ({ run: async () => { inserted.push(a); } }) }) },
      EVENTS: { send: async (e: unknown) => { sent.push(e); } },
      AGENT: { idFromName: (n: string) => n, get: (id: string) => ({ fetch: async () => { notified.push(id); return new Response(null, { status: 204 }); } }) },
    } as unknown as Env;
    const e = await emit(env, 'ws_1', 'tender.matched', { tender_id: 'tnd_1' });
    expect(e.id).toMatch(/^evt_/);
    expect(inserted[0]![1]).toBe('ws_1');
    expect(sent).toHaveLength(1);
    expect(notified).toEqual(['ws_1']);
    const broken = { ...env, DB: { prepare: () => { throw new Error('db down'); } }, EVENTS: { send: async () => { throw new Error('q down'); } } } as unknown as Env;
    await expect(emit(broken, 'ws_1', 'run.started')).resolves.toBeTruthy();
  });
});
