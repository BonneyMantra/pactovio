import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { makeEnv } from '../../../apps/api/test/helpers';
import { saveProduct } from '../src/catalogue';
import { matchDesignRequest } from '../src/match';

let env: Env;
let dispose: () => Promise<void>;
const a = 'ws_customer_catalogue_a', b = 'ws_customer_catalogue_b';
const input = { sku: 'env-40', name: 'Outdoor environmental sensor', unit_price_minor: 12500, currency: 'eur', unit: 'each' };

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  for (const id of [a, b]) await env.DB.prepare("INSERT INTO workspaces (id, name, segment, sample, profile_json, created_at) VALUES (?, ?, 'industrial', 0, '{}', ?)").bind(id, id, new Date().toISOString()).run();
}, 60_000);
afterAll(async () => dispose?.());

describe('private customer catalogue', () => {
  it('stores a real customer price, normalizes identifiers and permits the same SKU in another tenant', async () => {
    const product = await saveProduct(env.DB, a, input);
    expect(product).toMatchObject({ workspace_id: a, sku: 'ENV-40', currency: 'EUR', unit_price_minor: 12500 });
    expect(product.specs).toMatchObject({ unit: 'each', price_basis: 'Customer-provided catalogue price' });
    const other = await saveProduct(env.DB, b, input);
    expect(other.id).not.toBe(product.id);
  });

  it('rejects duplicate SKU, foreign tenant edits and sample workspace writes', async () => {
    await expect(saveProduct(env.DB, a, input)).rejects.toMatchObject({ code: 'duplicate_sku' });
    const p = await saveProduct(env.DB, a, { ...input, sku: 'env-41' });
    await expect(saveProduct(env.DB, b, { ...input, sku: 'env-42' }, p.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(saveProduct(env.DB, 'ws_harbour_digital', input)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await env.DB.prepare('SELECT unit_price_minor FROM products WHERE id = ?').bind(p.id).first()).toEqual({ unit_price_minor: 12500 });
  });

  it('updates only its own product and rejects negative, fractional, oversized or injected fields', async () => {
    const p = await saveProduct(env.DB, a, { ...input, sku: 'env-43' });
    const updated = await saveProduct(env.DB, a, { ...input, sku: 'env-43', unit_price_minor: 13000 }, p.id);
    expect(updated.unit_price_minor).toBe(13000);
    for (const bad of [{ unit_price_minor: -1 }, { unit_price_minor: 1.5 }, { currency: 'EURO' }, { workspace_id: b }, { unit_price_minor: 1e15 }]) {
      await expect(saveProduct(env.DB, a, { ...input, ...bad })).rejects.toBeDefined();
    }
  });

  it('guides an empty customer to catalogue and datasheet setup before any model spend', async () => {
    const ws = 'ws_new_catalogue_customer';
    await env.DB.prepare("INSERT INTO workspaces (id, name, segment, sample, profile_json, created_at) VALUES (?, 'Seabridge Instruments', 'industrial', 0, '{}', ?)").bind(ws, new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO design_requests (id, workspace_id, customer, subject, spec_text) VALUES ('design_empty_customer', ?, 'Harbourview Port', 'Outdoor sensors', 'Forty outdoor monitoring sensors with IP67 enclosures.')").bind(ws).run();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error('Unexpected model request'); };
    await expect(matchDesignRequest(env, 'design_empty_customer', { fetch })).rejects.toMatchObject({ code: 'catalogue_required' });
    await saveProduct(env.DB, ws, input);
    await expect(matchDesignRequest(env, 'design_empty_customer', { fetch })).rejects.toMatchObject({ code: 'datasheets_required' });
    expect(calls).toBe(0);
  });
});
