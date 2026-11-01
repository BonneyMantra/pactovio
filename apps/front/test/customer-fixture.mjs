// Isolated browser transport fixture. Never imported by or deployed with public assets.
// Run: node apps/front/test/customer-fixture.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
const publicRoot = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const state = { signedIn: false, company: {}, completed: false, products: [], errors: {}, email: '', calls: [] };
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const session = () => ({ authenticated: true, user: { id: 'usr_fixture', email: state.email }, workspace_id: 'ws_fixture', workspace: { id: 'ws_fixture', name: state.company.name || 'Your company', sample: 0, segment: state.company.supplier_segment }, onboarding_complete: state.completed });
const onboarding = () => ({ company: state.company, settings: {}, completed_at: state.completed ? '2026-11-01T01:00:00Z' : null, updated_at: new Date().toISOString() });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'); let raw = '';
  for await (const chunk of req) raw += chunk;
  let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, { error: 'Malformed fixture request' }, 400); }
  if (url.pathname === '/__fixture') { if (req.method === 'POST') Object.assign(state, body); return json(res, state); }
  if (url.pathname.startsWith('/api/')) {
    const path = url.pathname.slice(4); state.calls.push({ path, method: req.method, body });
    const error = state.errors[path]; if (error) return json(res, { error: error.message || 'Fixture service unavailable', code: error.code }, error.status);
    if (path === '/auth/code/request') { state.email = body.email; return json(res, { ok: true, retry_after: 2, expires_in: 600 }, 202); }
    if (path === '/auth/code/verify') {
      if (body.code !== '127456') return json(res, { error: 'Invalid or expired code', code: 'invalid_code' }, 400);
      state.signedIn = true; return json(res, session());
    }
    if (path === '/auth/logout') { state.signedIn = false; return json(res, { ok: true }); }
    if (!state.signedIn) return json(res, { error: 'Sign in to continue', code: 'unauthorized' }, 401);
    if (path === '/session') return json(res, session());
    if (path === '/onboarding') { if (req.method === 'PATCH') Object.assign(state.company, body.company); return json(res, onboarding()); }
    if (path === '/onboarding/complete') { state.completed = true; return json(res, onboarding()); }
    if (path === '/connectors') return json(res, { items: [{ provider: 'gmail', name: 'Gmail', category: 'email', status: 'available', description: 'Bring customer requests into your inbox' }, { provider: 'googledrive', name: 'Google Drive', category: 'files', status: 'pending' }, { provider: 'hubspot', name: 'HubSpot', category: 'crm', status: 'connected', account_label: 'Fixture account' }] });
    if (/^\/connectors\/.+\/connect$/.test(path)) return json(res, { error: 'Fixture blocks external OAuth', code: 'unavailable' }, 503);
    if (path === '/products' && req.method === 'GET') return json(res, { items: state.products });
    if (path === '/products' || path.startsWith('/products/')) {
      const id = path.split('/')[2] || `prd_${state.products.length + 1}`;
      if (state.products.some((p) => p.sku === body.sku && p.id !== id)) return json(res, { error: 'Duplicate SKU', code: 'duplicate_sku' }, 409);
      const product = { ...body, id, specs: { unit: body.unit }, workspace_id: 'ws_fixture', datasheet_doc_id: null };
      state.products = [...state.products.filter((p) => p.id !== id), product]; return json(res, product);
    }
    if (path === '/billing') return json(res, { plan: 'free', plans: [{ id: 'free', name: 'Scout', monthly_credits: 3, features: [] }], credits_balance: 3 });
    if (path === '/today') return json(res, { counts: { open_intakes: 0, new_matches: 0, approvals_pending: 0, runs_today: 0 }, intakes: [], top_matches: [], approvals: [], recent_runs: [] });
    if (path === '/workspaces') return json(res, { items: [session().workspace] });
    if (path === '/events/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
    return json(res, { items: [] });
  }
  const filename = resolve(publicRoot, `.${url.pathname === '/app' ? '/app.html' : url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!filename.startsWith(publicRoot + sep) && filename !== publicRoot) return json(res, {}, 403);
  try { const bytes = await readFile(filename); res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(filename)] || 'application/octet-stream' }); res.end(bytes); }
  catch { json(res, { error: 'Fixture file missing' }, 404); }
});
server.listen(Number(process.argv[2] || 43181), '127.0.0.1');
