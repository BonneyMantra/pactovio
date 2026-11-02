import { h, icon } from './ui.js';
const CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const names = new Intl.DisplayNames(['en'], { type: 'region' });
const countries = CODES.map((code) => ({ code, name: names.of(code) })).sort((a, b) => a.name.localeCompare(b.name));

export function countryPicker(value, onChange) {
  let selected = value || '', shown = [], active = -1, opened = false;
  const list = h('div.country-list', { id: 'company-countries', role: 'listbox', 'aria-label': 'Countries', hidden: true });
  const input = h('input.input', { id: 'company-country', role: 'combobox', type: 'text', autocomplete: 'off',
    'aria-autocomplete': 'list', 'aria-controls': list.id, 'aria-expanded': 'false', placeholder: 'Search countries',
    value: countries.find((c) => c.code === selected)?.name || '', onfocus: () => open(''),
    oninput: () => { selected = ''; onChange(''); open(input.value); },
    onkeydown: (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!opened) open('');
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; mark();
      }
      if (e.key === 'Enter' && opened && active >= 0) { e.preventDefault(); choose(shown[active]); }
      if (e.key === 'Tab') close();
    }, onblur: () => setTimeout(close, 120) });
  function close() { opened = false; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function choose(country) { if (!country) return; selected = country.code; input.value = country.name; onChange(selected); close(); }
  function mark() {
    [...list.children].forEach((el, i) => { el.setAttribute('aria-selected', String(i === active)); });
    if (list.children[active]) { input.setAttribute('aria-activedescendant', list.children[active].id); list.children[active].scrollIntoView({ block: 'nearest' }); }
  }
  function open(query) {
    opened = true; active = -1; list.hidden = false; input.setAttribute('aria-expanded', 'true');
    shown = countries.filter((c) => `${c.name} ${c.code}`.toLowerCase().includes(query.toLowerCase()));
    list.replaceChildren(...shown.map((c, i) => h('div.country-option', { role: 'option', id: `country-${c.code}`, 'aria-selected': 'false',
      onmousedown: (e) => { e.preventDefault(); choose(c); }, onmousemove: () => { active = i; mark(); } }, c.name, c.code === selected ? icon('check', 14) : null)));
    if (!shown.length) list.append(h('div.small.ink2', { style: { padding: '12px' } }, 'No country found. Try another name.'));
  }
  return { element: h('div.country-picker', input, list), input, getValue: () => selected };
}
