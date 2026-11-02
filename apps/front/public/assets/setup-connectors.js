import { api, h, icon, chip, providerMark } from './ui.js';
import { friendlyError, connectorDestination } from './customer-api.js';

export async function setupConnectors(root) {
  root.replaceChildren(h('p.small.ink2', { role: 'status' }, 'Checking available connections…'));
  try {
    const { items = [] } = await api('/connectors');
    root.replaceChildren(h('div.setup-connectors', items.filter((c) => ['email', 'files', 'crm'].includes(c.category?.toLowerCase())).map((c) => {
      const status = h('div.xs.ink2', { role: 'status' });
      const connected = c.status === 'connected';
      const button = h('button.btn.btn-secondary.btn-sm', { type: 'button', disabled: connected || c.status === 'needs_work_account', onclick: async () => {
        button.disabled = true; status.textContent = 'Opening secure connection…';
        try {
          const result = await api(`/connectors/${encodeURIComponent(c.provider)}/connect`, { method: 'POST', signal: AbortSignal.timeout(30000), body: { redirect_to: '/app#/onboarding' } });
          location.assign(connectorDestination(result?.redirect_url));
        } catch (e) { status.textContent = friendlyError(e); button.disabled = false; }
      } }, connected ? 'Connected' : c.status === 'pending' ? 'Reconnect' : 'Connect', connected ? icon('check', 14) : icon('out', 14));
      return h('div.setup-connector', h('div.setup-connector-head', providerMark(c.provider, 28), h('div', h('strong.small', c.name || c.provider),
        h('div.xs.ink2', connected ? c.account_label || 'Account connected' : c.status === 'pending' ? 'Connection pending — reconnect to finish' : c.status === 'needs_work_account' ? 'Requires a Microsoft work account' : c.description || 'Not connected'))), button, status);
    })), ...(!items.length ? [h('p.small.ink2', 'No connections are available right now. You can add requests manually.')] : []),
    h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => setupConnectors(root) }, icon('refresh', 14), 'Refresh connection status'));
  } catch (e) { root.replaceChildren(h('div.error-box', friendlyError(e)), h('button.btn.btn-secondary.btn-sm', { onclick: () => setupConnectors(root) }, 'Retry connections')); }
}
