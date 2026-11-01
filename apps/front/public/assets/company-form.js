import { h, icon } from './ui.js';
import { saveCompany, friendlyError } from './customer-api.js';
import { countryPicker } from './country-picker.js';

// In-memory draft is scoped to an authenticated workspace; never stored with a code or cookie.
let draftOwner = null, draft = null;
export function clearCompanyDraft() { draftOwner = null; draft = null; }
export function companyReady(c = {}) { return c.name?.trim().length >= 2 && /^[A-Z]{2}$/i.test(c.country || '') && ['it', 'industrial'].includes(c.supplier_segment) && c.capabilities?.length > 0; }

export function companyForm(company, workspace, onSaved, { editing = false } = {}) {
  if (draftOwner !== workspace) { clearCompanyDraft(); draftOwner = workspace; }
  const data = { ...company, ...(draft || {}) };
  let disposed = false, saving = false, timer = null, pending = Promise.resolve();
  const errors = {};
  const status = h('div.small.ink2.access-status', { role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const name = h('input.input', { id: 'company-name', name: 'organization', autocomplete: 'organization', maxlength: 160, value: data.name || '', placeholder: 'Your registered company name' });
  const website = h('input.input', { id: 'company-website', name: 'url', autocomplete: 'url', type: 'url', maxlength: 2048, value: data.website || '', placeholder: 'https://yourcompany.com' });
  const capabilities = h('textarea.input', { id: 'company-capabilities', rows: 4, maxlength: 8050, placeholder: 'One capability per line, for example:\nCloud migration\nManaged IT support' }, (data.capabilities || []).join('\n'));
  let segment = data.supplier_segment || '';
  const country = countryPicker(data.country, remember);
  const segments = h('div.company-segments', { role: 'group', 'aria-labelledby': 'segment-label' });
  const options = [['it', 'IT & services', 'Software, infrastructure and professional services'], ['industrial', 'Industrial', 'Equipment, manufacturing and supply']];
  for (const [id, label, description] of options) segments.append(h('button.company-segment', { type: 'button', 'aria-pressed': String(segment === id), onclick: () => {
    segment = id; [...segments.children].forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === id))); remember();
  } }, h('strong.small', label), h('span.xs.ink2', description), icon('check', 16)));
  const submit = h('button.btn.btn-primary', { type: 'submit' }, editing ? 'Save company details' : 'Save & continue', icon('arrow'));
  const form = h('form.company-form', { novalidate: true, oninput: remember, onsubmit: async (event) => {
    event.preventDefault(); if (saving) return;
    const value = read(); remember();
    const invalid = validate(value);
    for (const [key, el] of Object.entries(errors)) { el.textContent = invalid[key] || ''; controls[key]?.setAttribute('aria-invalid', String(!!invalid[key])); }
    if (Object.keys(invalid).length) { status.textContent = 'Check the highlighted details below.'; controls[Object.keys(invalid)[0]]?.focus(); return; }
    saving = true; submit.disabled = true; form.setAttribute('aria-busy', 'true'); status.textContent = 'Saving company details…';
    try {
      clearTimeout(timer); await pending;
      const result = await saveCompany(value);
      if (disposed) return;
      draft = null; status.textContent = 'Company details saved.'; await onSaved(result);
    } catch (error) { if (!disposed) { status.textContent = friendlyError(error); status.focus(); } }
    finally { saving = false; submit.disabled = false; form.setAttribute('aria-busy', 'false'); }
  } }, field('name', 'Company name', name), field('website', 'Website', website, 'Optional'),
    field('country', 'Country', country.element),
    h('div.access-field', h('span.access-label', { id: 'segment-label' }, 'Supplier segment'), segments, errorFor('supplier_segment')),
    field('capabilities', 'What can your company deliver?', capabilities, 'Add one capability per line. You can refine these later.'),
    status, h('div.company-actions', h('span.xs.ink2', editing ? 'Changes apply to this workspace.' : 'You can review these details in Company settings.'), submit));
  const controls = { name, website, country: country.input, supplier_segment: segments.firstChild, capabilities };
  for (const [key, control] of Object.entries(controls)) control.setAttribute('aria-describedby', `company-error-${key}`);
  function errorFor(key) { errors[key] = h('span.field-error.xs', { id: `company-error-${key}` }); return errors[key]; }
  function field(key, label, control, hint) { return h('div.access-field', h('label.access-label', { for: `company-${key}` }, label, hint === 'Optional' ? h('span.ink2', ' · optional') : null), control, hint && hint !== 'Optional' ? h('span.xs.ink2', hint) : null, errorFor(key)); }
  function read() { return { name: name.value.trim(), website: website.value.trim(), country: country.getValue(), supplier_segment: segment, capabilities: capabilities.value.split('\n').map((v) => v.trim()).filter(Boolean) }; }
  function remember() {
    draft = read(); clearTimeout(timer);
    if (disposed || saving) return;
    timer = setTimeout(() => {
      const value = read(), invalid = validate(value);
      const partial = Object.fromEntries(Object.entries(value).filter(([key]) => !invalid[key]));
      if (!Object.keys(partial).length) return;
      pending = pending.then(async () => {
        if (disposed) return;
        status.textContent = 'Saving draft…';
        try { await saveCompany(partial); if (!disposed && !saving) status.textContent = 'Draft saved. You can finish setup later.'; }
        catch (error) { if (!disposed && !saving) status.textContent = `Draft not saved. ${friendlyError(error)}`; }
      });
    }, 800);
  }
  return { element: form, dispose: () => { disposed = true; draft = read(); clearTimeout(timer); } };
}

function validate(c) {
  const errors = {};
  if (c.name.length < 2) errors.name = 'Enter a company name with at least two characters.';
  if (c.website) { try { if (!['http:', 'https:'].includes(new URL(c.website).protocol)) throw new Error(); } catch { errors.website = 'Use a full website address, starting with https://.'; } }
  if (!/^[A-Z]{2}$/.test(c.country)) errors.country = 'Choose your company’s country from the list.';
  if (!['it', 'industrial'].includes(c.supplier_segment)) errors.supplier_segment = 'Choose the segment that best fits your company.';
  if (!c.capabilities.length || c.capabilities.length > 50 || c.capabilities.some((v) => v.length > 160)) errors.capabilities = 'Add 1–50 capabilities, each no longer than 160 characters.';
  return errors;
}
