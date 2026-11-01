import { h, api } from '../ui.js';
import { getCompany, friendlyError } from '../customer-api.js';
import { companyForm } from '../company-form.js';

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Company settings');
  root.append(h('div.page-head', h('div', h('h1.title', 'Company settings'), h('div.sub', 'The company context Pactovio uses in your private workspace.'))));
  const body = h('div.card.company-settings', h('p.ink2', { role: 'status' }, 'Loading company details…'));
  root.append(body, h('a.card.company-settings-link', { href: '#/catalogue', style: { display: 'block', padding: '20px', maxWidth: '700px', marginTop: '20px' } }, h('strong.small', 'Products & prices →'), h('div.small.ink2', 'Manage the catalogue Pactovio uses for design requests and draft quotes.')));
  let form;
  async function draw() {
    try {
      const result = await getCompany();
      form = companyForm(result.company, ctx.session.workspace_id, async () => {
        ctx.session = await api('/session');
        ctx.setCrumbs('Company settings');
      }, { editing: true });
      body.replaceChildren(form.element);
    } catch (e) { body.replaceChildren(h('div.error-box', friendlyError(e)), h('button.btn.btn-secondary', { onclick: draw }, 'Retry company details')); }
  }
  await draw();
  return () => form?.dispose();
}
