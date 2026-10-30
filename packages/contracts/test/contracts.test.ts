import { describe, expect, it } from 'vitest';
import {
  buildOpenApi, CompanyProfile, endpointList, fromRow, newId, PackText, Quote, toRow, ulid, Workspace,
} from '../src';
import { buildSeed } from '../../../apps/api/scripts/seed-build';
import { harbourProfile, kestrelProfile } from '../../../apps/api/scripts/seed-companies';

describe('rows mapping', () => {
  it('round-trips JSON columns and boolean flags', () => {
    const entity = { id: 'wrk_1', name: 'X', profile: { a: [1, 2] }, sample: true, note: null };
    const row = toRow(entity);
    expect(row).toEqual({ id: 'wrk_1', name: 'X', profile_json: '{"a":[1,2]}', sample: 1, note: null });
    expect(fromRow(row)).toEqual(entity);
  });
  it('tolerates corrupt JSON instead of throwing', () => {
    expect(fromRow({ lots_json: '{oops' })).toEqual({ lots: null });
  });
});

describe('ids', () => {
  it('are prefixed, unique and time-sortable', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_001_000);
    expect(a < b).toBe(true);
    expect(newId('tender')).toMatch(/^tnd_[0-9a-z]{26}$/);
    expect(newId('tender')).not.toBe(newId('tender'));
  });
});

describe('schemas', () => {
  it('sample company profiles satisfy CompanyProfile and Workspace', () => {
    expect(() => CompanyProfile.parse(harbourProfile)).not.toThrow();
    expect(() => CompanyProfile.parse(kestrelProfile)).not.toThrow();
    expect(Workspace.parse({ id: 'ws_x', name: 'n', segment: 'it', profile: harbourProfile, sample: true, created_at: 'now' }).profile.staff?.total).toBe(64);
  });
  it('rejects float money and unknown segments', () => {
    expect(() => Quote.parse({ id: 'q', workspace_id: 'w', design_request_id: null, tender_id: null, currency: 'EUR', lines: [], subtotal_minor: 1.5, discount_minor: 0, tax_minor: 0, total_minor: 0, valid_until: null, status: 'draft' })).toThrow();
    expect(() => Workspace.parse({ id: 'w', name: 'n', segment: 'retail', profile: harbourProfile, sample: true, created_at: 'x' })).toThrow();
  });
  it('PackText round-trips', () => {
    const p = { docs: [{ docId: 'doc_1', filename: 'a.pdf', kind: 'pdf', isForm: false, pages: [{ n: 1, text: 'hello' }], images: [{ page: 1, r2Key: 'k' }] }] };
    expect(PackText.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('seed SQL is generated, idempotent upserts only', () => {
    const sql = buildSeed();
    expect(sql).toContain('ON CONFLICT');
    expect(sql).not.toMatch(/\bDELETE\b/);
  });
});

describe('endpoint registry and OpenAPI', () => {
  it('has unique ids and method+path pairs', () => {
    const ids = new Set(endpointList.map((e) => e.id));
    const routes = new Set(endpointList.map((e) => `${e.method} ${e.path}`));
    expect(ids.size).toBe(endpointList.length);
    expect(routes.size).toBe(endpointList.length);
  });
  it('builds an OpenAPI 3.1 document with the error envelope', () => {
    const doc = buildOpenApi() as { openapi: string; paths: Record<string, unknown>; components: { schemas: { ErrorBody: unknown } } };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/today');
    expect(doc.components.schemas.ErrorBody).toBeTruthy();
  });
});
