import { h, icon } from './ui.js';
import { getCompany, completeCompany, friendlyError } from './customer-api.js';
import { gateLayout, gateError } from './access.js';
import { companyForm, companyReady } from './company-form.js';
import { setupConnectors } from './setup-connectors.js';

export async function renderOnboarding(root, session, onComplete, onLogout) {
  let form = null, disposed = false, company = {};
  const dispose = () => { disposed = true; form?.dispose(); };
  async function start() {
    gateLayout(root, h('section.card.access-card', h('p.ink2', { role: 'status' }, 'Loading your company setup…')), true);
    try {
      const result = await getCompany(); if (disposed) return; company = result.company || {};
      if (companyReady(company)) connections(); else details();
    } catch (e) { if (!disposed) gateError(root, e, start); }
  }
  function frame(step, title, description, content) {
    gateLayout(root, h('section.card.access-card.company-card',
      h('div.setup-progress', h('span', { class: step === 1 ? 'on' : '' }, '01 Company'), h('span', { class: step === 2 ? 'on' : '' }, '02 Connections')),
      h('h2.h2', { tabindex: '-1' }, title), h('p.ink2', description), content,
      h('div.setup-identity.small.ink2', h('span', session.user.email), h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: onLogout }, 'Sign out'))), true);
    root.querySelector('h2')?.focus({ preventScroll: true }); window.scrollTo(0, 0);
  }
  function details() {
    form?.dispose();
    form = companyForm(company, session.workspace_id, async (result) => { company = result.company; if (!disposed) connections(); });
    frame(1, 'Tell us about your company', 'Give Pactovio the context to understand what you can deliver. Add evidence once your workspace is ready.', form.element);
    root.querySelector('input')?.focus();
  }
  function connections() {
    form?.dispose(); form = null;
    const body = h('div'), status = h('div.access-status.small.ink2', { role: 'status' });
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (params.get('status') === 'failed') status.textContent = 'The connection did not complete. You can reconnect below or continue without it.';
    if (params.get('status') === 'success') status.textContent = 'You’re back. Checking the provider’s current connection status below.';
    const finish = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
      finish.disabled = true; status.textContent = 'Finishing your workspace…';
      try { await completeCompany(); if (!disposed) await onComplete(); }
      catch (e) { if (!disposed) { status.textContent = friendlyError(e); finish.disabled = false; } }
    } }, 'Open my workspace', icon('arrow'));
    frame(2, 'Connect what you work with', 'Optional. Connect email, files or your CRM now, or start with a request you add yourself. You can manage connections later.',
      h('div', body, status, h('div.company-actions', h('button.btn.btn-ghost', { type: 'button', onclick: details }, 'Back to company'), finish)));
    setupConnectors(body);
  }
  await start();
  return dispose;
}
