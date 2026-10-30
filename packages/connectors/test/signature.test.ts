import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signComposioWebhook, verifyComposioWebhook } from '../src';

const SECRET = 'whsec-test-secret-not-real';
const BODY = JSON.stringify({ id: 'msg_1', type: 'composio.trigger.message', metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' }, data: { subject: 'RFQ' } });
const NOW = 1_761_800_000;
const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const signed = async (over: Record<string, string> = {}) => headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(NOW), 'webhook-signature': await signComposioWebhook(SECRET, 'msg_1', NOW, BODY), ...over });

describe('Composio webhook signature', () => {
  it('matches the documented scheme: HMAC-SHA256 over id.timestamp.body, base64, "v1," prefix', async () => {
    const expected = `v1,${createHmac('sha256', SECRET).update(`msg_1.${NOW}.${BODY}`).digest('base64')}`;
    expect(await signComposioWebhook(SECRET, 'msg_1', NOW, BODY)).toBe(expected);
    expect(await verifyComposioWebhook(SECRET, await signed(), BODY, NOW)).toEqual({ ok: true });
  });
  it('rejects a tampered body, a wrong secret and a wrong id', async () => {
    expect(await verifyComposioWebhook(SECRET, await signed(), BODY.replace('RFQ', 'RFP'), NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyComposioWebhook('another-secret', await signed(), BODY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyComposioWebhook(SECRET, await signed({ 'webhook-id': 'msg_2' }), BODY, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('rejects replays older or newer than 300 seconds', async () => {
    expect(await verifyComposioWebhook(SECRET, await signed(), BODY, NOW + 301)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(await verifyComposioWebhook(SECRET, await signed(), BODY, NOW - 301)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(await verifyComposioWebhook(SECRET, await signed(), BODY, NOW + 299)).toEqual({ ok: true });
  });
  it('requires all three headers and a configured secret', async () => {
    expect(await verifyComposioWebhook(SECRET, await signed({ 'webhook-signature': '' }), BODY, NOW)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(await verifyComposioWebhook(SECRET, headers({}), BODY, NOW)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(await verifyComposioWebhook(undefined, await signed(), BODY, NOW)).toEqual({ ok: false, reason: 'no_secret' });
    expect(await verifyComposioWebhook('', await signed(), BODY, NOW)).toEqual({ ok: false, reason: 'no_secret' });
  });
  it('accepts any one of several space-separated signatures (secret rotation)', async () => {
    const good = await signComposioWebhook(SECRET, 'msg_1', NOW, BODY);
    expect(await verifyComposioWebhook(SECRET, await signed({ 'webhook-signature': `v1,AAAA ${good}` }), BODY, NOW)).toEqual({ ok: true });
  });
  it('supports a whsec_ base64 secret as well as the raw string', async () => {
    const raw = Buffer.from('super-secret-key-bytes').toString('base64');
    const sig = `v1,${createHmac('sha256', Buffer.from('super-secret-key-bytes')).update(`msg_1.${NOW}.${BODY}`).digest('base64')}`;
    expect(await verifyComposioWebhook(`whsec_${raw}`, headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(NOW), 'webhook-signature': sig }), BODY, NOW)).toEqual({ ok: true });
  });
});
