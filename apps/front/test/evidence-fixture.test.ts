import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
let server: ChildProcess, origin: string;
beforeAll(async () => {
  server = fork(fileURLToPath(new URL('./customer-fixture.mjs', import.meta.url).href), ['0'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  origin = await new Promise<string>((resolve, reject) => {
    server.once('message', (message) => resolve(`http://127.0.0.1:${(message as { port: number }).port}`));
    server.once('error', reject); server.once('exit', () => reject(new Error('Fixture exited before startup')));
  });
});
afterAll(() => { server?.kill(); });
it('fixture verifies multipart acceptance and actual listed evidence rather than a CLI upload acknowledgement', async () => {
  const form = new FormData();
  form.append('file', new File(['Model MXR-24: 24 ports, 10 Gbps uplink. Supplier-stated specifications.'], 'mxr-24.txt', { type: 'text/plain' }));
  form.append('title', 'MXR-24 datasheet'); form.append('kind', 'datasheet');
  expect((await fetch(`${origin}/api/evidence`, { method: 'POST', body: form })).status).toBe(401);
  await fetch(`${origin}/__fixture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedIn: true }) });
  const receipt = await (await fetch(`${origin}/api/evidence`, { method: 'POST', body: form })).json() as { evidence_id: string; status: string };
  expect(receipt.status).toBe('ready');
  const list = await (await fetch(`${origin}/api/evidence`)).json() as { items: { id: string; title: string; text: string }[] };
  expect(list.items).toHaveLength(1); expect(list.items[0].id).toBe(receipt.evidence_id);
  expect(list.items[0].title).toBe('MXR-24 datasheet'); expect(list.items[0].text).toContain('24 ports');
});
