// Cloudflare Pages advanced-mode worker for https://pactovio.pages.dev
// /api/*, /v1/*, /mcp*, /webhooks/*, /ics/*, /dev/* -> service binding API (pactovio-api)
// everything else -> service binding WEB (pactovio-web, the UI) when bound, otherwise the static
// placeholder pages in this folder (landing, privacy, terms) via ASSETS, otherwise API.
const API_PATH = /^\/(api|v1|dev|webhooks|ics)(\/|$)|^\/mcp/;

export function isApiPath(pathname) {
  return API_PATH.test(pathname);
}

export function pickTarget(pathname, env) {
  if (isApiPath(pathname)) return env.API;
  return env.WEB ?? env.ASSETS ?? env.API;
}

export default {
  async fetch(request, env) {
    const target = pickTarget(new URL(request.url).pathname, env);
    if (!target) return new Response(JSON.stringify({ error: 'API service binding missing', code: 'misconfigured' }), { status: 502, headers: { 'content-type': 'application/json' } });
    return target.fetch(request);
  },
};
