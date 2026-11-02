import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@pactovio/contracts/env';
import { customerFixture } from '../../../apps/api/test/customer-fixture';
import { makeEnv } from '../../../apps/api/test/helpers';
import { completeCallback, connectUrl } from '../src/accounts';
import { stateToken, tokenHash } from '../src/identity';
import { getConnector } from '../src/store';
import { fakeComposio } from './fake-composio';

let env: Env, dispose: () => Promise<void>;
beforeAll(async () => { ({ env, dispose } = await makeEnv()); env.COMPOSIO_API_KEY = 'transport-test'; }, 60000);
afterAll(async () => dispose?.());

describe('OAuth callback replacement during provider verification', () => {
  it.each([false, true])('preserves a newer attempt when the earlier provider call fails=%s', async (failure) => {
    const customer = await customerFixture(env), a = stateToken(), b = stateToken();
    const uid = `pactovio-workspace-${customer.workspace}`;
    const f = fakeComposio({}, { accounts: [{ id: 'ca_new_ac_outlook', toolkit: { slug: 'outlook' }, status: 'ACTIVE', user_id: uid }] });
    await connectUrl(env, customer.workspace, 'outlook', { sessionId: customer.session, state: a }, { fetch: f.fetch });
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const slow: typeof fetch = async (input, init) => {
      if (String(input).includes('/connected_accounts/ca_new_ac_outlook')) {
        entered(); await resume;
        if (failure) return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
      }
      return f.fetch(input, init);
    };
    const finishing = completeCallback(env, { state: a }, { fetch: slow }, customer.session);
    await paused;
    await connectUrl(env, customer.workspace, 'outlook', { sessionId: customer.session, state: b }, { fetch: f.fetch });
    release();
    expect((await finishing).ok).toBe(false);
    const current = await getConnector(env, customer.workspace, 'outlook');
    expect(current?.status).toBe('pending');
    expect(current?.meta.pending.state_hash).toBe(await tokenHash(b));
    expect((await getConnector(env, customer.workspace, 'outlook_calendar'))?.status).not.toBe('connected');
    expect(f.log.some((line) => line.startsWith('POST /trigger_instances/'))).toBe(false);
  });
});
