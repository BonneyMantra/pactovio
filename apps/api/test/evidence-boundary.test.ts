import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { buildApp } from '../src/app';
import { makeEnv } from './helpers';
import { customerFixture } from './customer-fixture';

let env: Env, dispose: () => Promise<void>, cookie: string, workspace: string;
const { app } = buildApp();
const context = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
beforeAll(async () => { ({ env, dispose } = await makeEnv()); ({ cookie, workspace } = await customerFixture(env)); }, 60000);
afterAll(async () => dispose?.());

it('rejects unsafe multipart metadata, duplicate files and unsupported files before model or storage work', async () => {
  for (const bad of ['kind', 'date', 'title', 'duplicate', 'extension', 'workspace']) {
    const form = new FormData();
    form.append('file', new File(['Customer-supplied technical requirements for a monitoring sensor.'], bad === 'extension' ? 'script.exe' : 'datasheet.txt', { type: 'text/plain' }));
    form.append('kind', bad === 'kind' ? 'untrusted-kind' : 'datasheet');
    if (bad === 'date') form.append('valid_to', '2026-02-31');
    if (bad === 'title') form.append('title', 'A'.repeat(201));
    if (bad === 'workspace') form.append('workspace_id', 'ws_harbour_digital');
    if (bad === 'duplicate') form.append('file', new File(['Second file'], 'second.txt'));
    const result = await app.fetch(new Request('http://localhost/api/evidence', { method: 'POST', body: form,
      headers: { cookie, origin: 'http://localhost' } }), env, context);
    expect(result.status, bad).toBe(400);
    expect(await result.json()).toMatchObject({ code: 'validation' });
  }
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM evidence WHERE workspace_id = ?').bind(workspace).first()).toEqual({ n: 0 });
});
