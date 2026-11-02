import { api, h, icon } from './ui.js';
import { friendlyError } from './customer-api.js';

export const CATALOGUE_CURRENCIES = 'USD EUR GBP MYR INR AUD CAD SGD CHF CNY HKD NZD AED SAR ZAR SEK NOK DKK PLN CZK THB ILS BRL MXN PHP TRY'.split(' ');
export const supportedCurrency = (value) => CATALOGUE_CURRENCIES.includes(String(value).trim().toUpperCase());

// Decimal-string conversion avoids floating-point rounding of customer prices.
export function priceToMinor(value) {
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor <= 1e12 ? minor : null;
}
export function minorToPrice(minor) { return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`; }

export function catalogueForm(product, onSaved, onCancel) {
  const fields = {};
  const status = h('div.access-status.small.ink2', { role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const field = (key, label, value, props = {}) => {
    fields[key] = h('input.input', { id: `product-${key}`, value: value ?? '', ...props });
    return h('div.access-field', h('label.access-label', { for: `product-${key}` }, label), fields[key]);
  };
  let saving = false;
  const save = h('button.btn.btn-primary', { type: 'submit' }, product ? 'Save changes' : 'Add product', icon('check'));
  const cancel = h('button.btn.btn-secondary', { type: 'button', onclick: onCancel }, 'Cancel');
  const form = h('form.company-form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); if (saving) return;
    const value = Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, el.value.trim()]));
    const price = priceToMinor(value.price);
    const invalid = [];
    if (!value.sku || value.sku.length > 64) invalid.push(['sku', 'Enter a SKU with 1–64 characters.']);
    if (value.name.length < 2 || value.name.length > 160) invalid.push(['name', 'Enter a product name with 2–160 characters.']);
    if (!value.unit) invalid.push(['unit', 'Enter the unit this price applies to.']);
    if (price === null) invalid.push(['price', 'Enter a price from 0 to 10,000,000,000 with at most two decimal places, without commas.']);
    if (!supportedCurrency(value.currency)) invalid.push(['currency', 'Choose a supported two-decimal currency from the list below. Currencies such as JPY and KWD are not supported.']);
    Object.entries(fields).forEach(([key, input]) => input.setAttribute('aria-invalid', String(invalid.some(([k]) => k === key))));
    if (invalid.length) { status.textContent = invalid.map(([, text]) => text).join(' '); fields[invalid[0][0]].focus(); return; }
    saving = true; save.disabled = true; cancel.disabled = true; form.setAttribute('aria-busy', 'true'); status.textContent = 'Saving product…';
    try {
      await api(product ? `/products/${encodeURIComponent(product.id)}` : '/products', { method: product ? 'PUT' : 'POST',
        body: { sku: value.sku, name: value.name, family: value.family || null, unit: value.unit, unit_price_minor: price, currency: value.currency.toUpperCase() } });
      await onSaved();
    } catch (error) { status.textContent = error.code === 'duplicate_sku' ? 'This SKU already exists. Edit the existing product or use a different SKU.' : friendlyError(error); status.focus(); }
    finally { saving = false; save.disabled = false; cancel.disabled = false; form.setAttribute('aria-busy', 'false'); }
  } }, h('h2.h3', product ? 'Edit product' : 'Add a product'),
    h('p.small.ink2', 'Enter your actual catalogue price. This becomes the source price for draft quotes.'),
    field('sku', 'SKU', product?.sku, { maxlength: 64, autocomplete: 'off' }),
    field('name', 'Product name', product?.name, { maxlength: 160 }),
    field('family', 'Product family · optional', product?.family, { maxlength: 160 }),
    h('div.catalogue-fields', field('price', 'Unit price', product ? minorToPrice(product.unit_price_minor) : '', { inputmode: 'decimal', placeholder: '0.00' }),
      field('currency', 'Currency code', product?.currency, { maxlength: 3, placeholder: 'MYR', 'aria-describedby': 'catalogue-currencies', style: { textTransform: 'uppercase' } }),
      field('unit', 'Priced per', product?.unit || product?.specs?.unit || 'each', { maxlength: 40 })),
    h('p.xs.ink2', { id: 'catalogue-currencies' }, `Supported currencies (two decimal places): ${CATALOGUE_CURRENCIES.join(', ')}.`),
    status, h('div.company-actions', cancel, save));
  return form;
}
