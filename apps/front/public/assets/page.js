// Shared script for the static marketing pages (pricing, privacy, terms): icons, nav hairline, comparison marks.
import { icon } from './ui.js';

document.querySelectorAll('[data-ico]').forEach((el) => {
  el.appendChild(icon(el.dataset.ico, el.classList.contains('tile-o') ? 34 : 15));
});
document.querySelectorAll('[data-yes]').forEach((el) => { el.classList.add('yes'); el.appendChild(icon('check', 16)); el.setAttribute('aria-label', 'Included'); });
document.querySelectorAll('[data-no]').forEach((el) => { el.classList.add('no'); el.textContent = '—'; el.setAttribute('aria-label', 'Not included'); });
const nav = document.getElementById('nav');
if (nav) {
  const on = () => nav.classList.toggle('scrolled', scrollY > 8);
  on();
  addEventListener('scroll', on, { passive: true });
}
