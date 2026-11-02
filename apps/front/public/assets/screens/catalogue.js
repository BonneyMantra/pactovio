import { api, h, icon, empty } from '../ui.js';
import { friendlyError } from '../customer-api.js';
import { catalogueForm, minorToPrice } from '../catalogue-form.js';

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Company settings', 'Catalogue');
  const list = h('div.card'), editor = h('div.card.company-settings', { hidden: true });
  const add = h('button.btn.btn-primary', { type: 'button', onclick: () => edit() }, 'Add product', icon('arrow'));
  root.append(h('div.page-head', h('div', h('h1.title', 'Company catalogue'), h('div.sub', 'Your products and prices for matching design requests and drafting quotes.')), add),
    h('p.small.ink2', 'Upload product datasheets in ', h('a', { href: '#/evidence', style: { textDecoration: 'underline' } }, 'Evidence'), ' to support specification matching. Prices entered here belong to this workspace.'), editor, list);
  let disposed = false;
  async function loadList() {
    list.replaceChildren(h('p.small.ink2', { style: { padding: '20px' }, role: 'status' }, 'Loading your catalogue…'));
    try {
      const { items = [] } = await api('/products'); if (disposed) return;
      list.replaceChildren(items.length ? h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Product'), h('th', 'SKU'), h('th', 'Unit price'), h('th', ''))),
        h('tbody', items.map((p) => h('tr', h('td', h('strong.small', p.name), p.family ? h('div.xs.ink2', p.family) : null), h('td.mono', p.sku),
          h('td.num', `${p.currency} ${minorToPrice(p.unit_price_minor)}`, h('div.xs.ink2', `per ${p.unit || p.specs?.unit || 'each'}`)),
          h('td.r', h('button.btn.btn-secondary.btn-sm', { type: 'button', 'aria-label': `Edit ${p.name}`, onclick: () => edit(p) }, 'Edit'))))))) :
        empty('Your catalogue starts here', 'Add the products you supply and their real prices before matching a design request.', h('button.btn.btn-primary', { onclick: () => edit() }, 'Add your first product')));
    } catch (e) { if (!disposed) list.replaceChildren(h('div.error-box', friendlyError(e)), h('button.btn.btn-secondary', { onclick: loadList }, 'Retry catalogue')); }
  }
  function close() { editor.hidden = true; editor.replaceChildren(); add.disabled = false; add.focus(); }
  function edit(product) {
    add.disabled = true; editor.hidden = false;
    editor.replaceChildren(catalogueForm(product, async () => { if (disposed) return; close(); await loadList(); }, close));
    editor.querySelector('input')?.focus();
  }
  await loadList();
  return () => { disposed = true; };
}
