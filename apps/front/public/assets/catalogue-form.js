import { api, h, icon } from './ui.js';
import { friendlyError } from './customer-api.js';
export const CATALOGUE_CURRENCIES = 'USD EUR GBP MYR INR AUD CAD SGD CHF CNY HKD NZD AED SAR ZAR SEK NOK DKK PLN CZK THB ILS BRL MXN PHP TRY'.split(' ');
export const supportedCurrency = value => CATALOGUE_CURRENCIES.includes(String(value).trim().toUpperCase());
export function priceToMinor(value) {
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const minor = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  return Number.isSafeInteger(minor) && minor <= 1e12 ? minor : null;
}
export function minorToPrice(minor) { return Number.isSafeInteger(minor) && minor >= 0 ? `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}` : ''; }
export function catalogueForm(product, onSaved, onCancel) {
  const fields = {}, internal = product?.specs?.sku_origin === 'internal_reference';
  const status = h('div.access-status.small.ink2', { role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const field = (key, label, value, props = {}, multiline = false) => {
    fields[key] = h(multiline ? 'textarea.input' : 'input.input', { id: `product-${key}`, ...(!multiline ? { value: value ?? '' } : {}), ...props });
    if (multiline) fields[key].value = value ?? '';
    return h('div.access-field', h('label.access-label', { for: `product-${key}` }, label), fields[key]);
  };
  const zero = { price: false, cost: false }, zeroButtons = {};
  function confirmation(key, label) {
    const button = h('button.btn.btn-secondary', { type: 'button', role: 'checkbox', 'aria-checked': 'false',
      onclick: () => { zero[key] = !zero[key]; button.setAttribute('aria-checked', String(zero[key])); button.textContent = `${zero[key] ? '✓ ' : ''}${label}`; } }, label);
    zeroButtons[key] = button; button.hidden = true; return button;
  }
  const sellingZero = confirmation('price', 'I confirm the selling price is explicitly zero');
  const costZero = confirmation('cost', 'I confirm the internal cost is explicitly zero');
  let saving = false;
  const save = h('button.btn.btn-primary', { type: 'submit' }, product ? 'Save changes' : 'Add product', icon('check'));
  const cancel = h('button.btn.btn-secondary', { type: 'button', onclick: onCancel }, 'Cancel');
  const form = h('form.company-form', { novalidate: true, onsubmit: async e => {
    e.preventDefault(); if (saving) return;
    const value = Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, el.value.trim()]));
    const price = priceToMinor(value.price), cost = priceToMinor(value.cost), invalid = [];
    if (value.sku.length > 64) invalid.push(['sku', 'Use at most 64 characters for the optional manufacturer SKU.']);
    if (value.name.length < 2 || value.name.length > 160) invalid.push(['name', 'Enter a product name with 2–160 characters.']);
    if (!value.description || value.description.length > 4096) invalid.push(['description', 'Enter a usable product description, up to 4,096 characters.']);
    if (value.family.length > 100) invalid.push(['family', 'Use at most 100 characters for product family.']);
    for (const [key, amount, currency, unit, label] of [['price', price, 'currency', 'unit', 'selling price'], ['cost', cost, 'cost_currency', 'cost_unit', 'internal cost']]) {
      if (amount === null) invalid.push([key, `Enter the ${label} as a nonnegative amount with at most two decimal places. Blank is not zero.`]);
      if (amount === 0 && !zero[key]) invalid.push([key, `Confirm that the ${label} is explicitly zero.`]);
      if (!supportedCurrency(value[currency])) invalid.push([currency, `Enter a supported currency for the ${label}.`]);
      if (!value[unit] || value[unit].length > 40) invalid.push([unit, `Enter the unit the ${label} applies to, up to 40 characters.`]);
    }
    Object.entries(fields).forEach(([key, input]) => input.setAttribute('aria-invalid', String(invalid.some(([k]) => k === key))));
    if (invalid.length) { status.textContent = invalid.map(([, text]) => text).join(' '); fields[invalid[0][0]].focus(); return; }
    saving = true; save.disabled = true; cancel.disabled = true; form.setAttribute('aria-busy', 'true'); status.textContent = 'Saving product…';
    Object.values(fields).forEach(input => input.disabled = true); Object.values(zeroButtons).forEach(button => button.disabled = true);
    try {
      await api(product ? `/products/${encodeURIComponent(product.id)}` : '/products', { method: product ? 'PUT' : 'POST',
        body: { ...(value.sku ? { sku: value.sku.toUpperCase() } : {}), name: value.name, description: value.description, family: value.family || null,
          unit: value.unit, unit_price_minor: price, currency: value.currency.toUpperCase(),
          internal_unit_cost_minor: cost, cost_currency: value.cost_currency.toUpperCase(), cost_unit: value.cost_unit,
          zero_price_confirmed: zero.price, zero_cost_confirmed: zero.cost } });
      await onSaved();
    } catch (error) { status.textContent = error.code === 'duplicate_sku' ? 'This manufacturer SKU already exists. Edit the existing product or correct the SKU.' : friendlyError(error); status.focus(); }
    finally { saving = false; save.disabled = false; cancel.disabled = false; form.setAttribute('aria-busy', 'false'); Object.values(fields).forEach(input => input.disabled = false); Object.values(zeroButtons).forEach(button => button.disabled = false); }
  } }, h('h2.h3', product ? 'Edit product' : 'Add a product'),
    h('p.small.ink2', 'Enter actual product details, internal cost and selling price. Internal cost stays private and is not included in customer quotes.'),
    internal ? h('p.small.ink2', `Internal reference: ${product.sku}. This is not a manufacturer SKU.`) : null,
    field('sku', 'Manufacturer SKU · optional', internal ? '' : product?.sku, { maxlength: 64, autocomplete: 'off' }),
    field('name', 'Product name', product?.name, { maxlength: 160 }),
    field('description', 'Usable product description', product?.description ?? product?.specs?.description, { maxlength: 4096, rows: 3 }, true),
    field('family', 'Product family · optional', product?.family, { maxlength: 100 }),
    h('h3.h4', 'Selling price'),
    h('div.catalogue-fields', field('price', 'Amount (decimal)', minorToPrice(product?.unit_price_minor), { inputmode: 'decimal', maxlength: 15 }),
      field('currency', 'Selling currency', product?.currency, { maxlength: 3, 'aria-describedby': 'catalogue-currencies', style: { textTransform: 'uppercase' } }),
      field('unit', 'Selling unit', product?.unit ?? product?.specs?.unit, { maxlength: 40 })), sellingZero,
    h('h3.h4', 'Internal unit cost · private'),
    h('div.catalogue-fields', field('cost', 'Amount (decimal)', minorToPrice(product?.internal_unit_cost_minor), { inputmode: 'decimal', maxlength: 15 }),
      field('cost_currency', 'Cost currency', product?.cost_currency, { maxlength: 3, 'aria-describedby': 'catalogue-currencies', style: { textTransform: 'uppercase' } }),
      field('cost_unit', 'Cost unit', product?.cost_unit, { maxlength: 40 })), costZero,
    h('p.xs.ink2', { id: 'catalogue-currencies' }, `Supported currencies (two decimal places): ${CATALOGUE_CURRENCIES.join(', ')}. No currency or unit is assumed.`),
    status, h('div.company-actions', cancel, save));
  for (const key of ['price', 'cost']) {
    const update = () => { zero[key] = false; zeroButtons[key].setAttribute('aria-checked', 'false'); zeroButtons[key].textContent = key === 'price' ? 'I confirm the selling price is explicitly zero' : 'I confirm the internal cost is explicitly zero'; zeroButtons[key].hidden = priceToMinor(fields[key].value.trim()) !== 0; };
    fields[key].addEventListener('input', update); update();
  }
  return form;
}
