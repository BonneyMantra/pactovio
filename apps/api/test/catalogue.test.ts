import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';
import { customerFixture } from './customer-fixture';

let env: Env, dispose: () => Promise<void>;
let owner: Awaited<ReturnType<typeof customerFixture>>, other: typeof owner;
const { app } = buildApp();
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const input = { sku: 'SEA-40', name: 'Coastal monitoring sensor', unit_price_minor: 120029, currency: 'MYR', unit: 'each' };
const call = (path: string, cookie: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
  app.fetch(new Request(`http://localhost/api${path}`, { method,
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, context);

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  owner = await customerFixture(env); other = await customerFixture(env);
}, 60000);
afterAll(async () => dispose?.());

describe('customer catalogue HTTP boundary', () => {
  let id: string;
  it('requires login and persists only the authenticated company product and exact price', async () => {
    expect((await call('/products', '', input)).status).toBe(401);
    const res = await call('/products', owner.cookie, input);
    expect(res.status).toBe(200);
    const product = await res.json() as { id: string; workspace_id: string; unit_price_minor: number };
    id = product.id;
    expect(product).toMatchObject({ workspace_id: owner.workspace, unit_price_minor: 120029 });
    expect(await (await call('/products', other.cookie)).json()).toEqual({ items: [] });
  });
  it('rejects foreign edits, duplicate SKUs and workspace injection without affecting the saved price', async () => {
    expect((await call(`/products/${id}`, other.cookie, { ...input, unit_price_minor: 1 }, 'PUT')).status).toBe(404);
    expect((await call('/products', owner.cookie, input)).status).toBe(409);
    expect((await call('/products', owner.cookie, { ...input, workspace_id: other.workspace })).status).toBe(400);
    expect((await call(`/products/${id}`, owner.cookie, { ...input, unit_price_minor: 129999 }, 'PUT')).status).toBe(200);
    const products = await (await call('/products', owner.cookie)).json() as { items: { unit_price_minor: number }[] };
    expect(products.items).toHaveLength(1);
    expect(products.items[0]!.unit_price_minor).toBe(129999);
  });
});
