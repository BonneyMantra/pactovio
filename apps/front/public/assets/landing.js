// Landing interactions: icons, sticky nav hairline, hero reveal, composer typing, capability list, logo wall, rosters.
import { icon } from './ui.js';
import { AGENTS, CAPS, CONNECTORS, MARKS, MODELS } from './landing-data.js';

const $ = (sel, root = document) => root.querySelector(sel);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function fillIcons(root = document) {
  root.querySelectorAll('[data-ico]').forEach((el) => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    el.appendChild(icon(el.dataset.ico, el.classList.contains('tile-o') ? 34 : el.classList.contains('ict') ? 22 : 15));
  });
}

const mark = (k) => `<span class="mk" style="background:${MARKS[k][0]}">${MARKS[k][1]}</span>`;
const cites = (html) => html.replace(/\[(\d+)\]/g, '<span class="cite">$1</span>');
const logo = (x, cls = 'logo') => x.src
  ? `<span class="${cls}" style="--src:url('${x.src}');--brand:${x.brand || 'var(--ink)'}" role="img" aria-label="${esc(x.name)} logo"></span>`
  : `<span class="logo-txt" aria-hidden="true">${esc(x.text || x.name)}</span>`;

function nav() {
  const n = $('#nav');
  const on = () => n.classList.toggle('scrolled', scrollY > 8);
  on();
  addEventListener('scroll', on, { passive: true });
}

function heroReveal() {
  const step = $('.tw[data-step="1"]');
  if (!step) return;
  setTimeout(() => step.classList.add('on'), reduce ? 0 : 1100);
  typeLoop($('#hero-ph'), ['Ask about a tender, an RFQ or a quote…', 'Which tenders close this week?', 'Draft a reply to the port authority'], 2600);
}

function typeLoop(el, phrases, hold) {
  if (!el) return;
  if (reduce) { el.textContent = phrases[0]; return; }
  let i = 0;
  const run = () => {
    const text = phrases[i % phrases.length];
    let c = 0;
    const tick = setInterval(() => {
      el.textContent = text.slice(0, ++c);
      if (c >= text.length) { clearInterval(tick); setTimeout(() => { i += 1; run(); }, hold); }
    }, 38);
  };
  run();
}

function floatCard() {
  const box = $('#v-float');
  if (!box) return;
  const spots = [[16, 22], [62, 14], [38, 40], [78, 46], [12, 62], [54, 66], [84, 20], [28, 12]];
  const live = CONNECTORS.filter((c) => c.src).slice(0, spots.length);
  box.innerHTML = live.map((c, i) => `<span class="float" style="left:${spots[i][0]}%;top:${spots[i][1]}%;animation-delay:-${i * 0.9}s"><span class="appico-sm" style="display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:#fff;box-shadow:0 0 0 0.5px var(--line),0 6px 16px rgba(0,0,0,.07)"><span class="logo" style="--src:url('${c.src}');background-color:${c.brand};width:18px;height:18px"></span></span></span>`).join('');
}

function caps() {
  const list = $('#caps');
  const panel = $('#ans');
  if (!list || !panel) return;
  const show = (i) => {
    const c = CAPS[i];
    list.querySelectorAll('li').forEach((li, j) => { li.classList.toggle('on', j === i); li.setAttribute('aria-selected', String(j === i)); });
    panel.innerHTML = `<div class="body">
      <div class="q msg"><span class="av you">BM</span><div><div class="name">You</div><div class="txt">${esc(c.q)}</div></div></div>
      <div class="msg"><span class="av bot">${icon('spark', 13).outerHTML}</span><div>
        <div class="name">Pactovio</div><div class="done-row">Completed ${c.src.length + 2} actions ${icon('chev', 13).outerHTML}</div>
        <div class="txt">${cites(c.a)}</div>
        <div class="srcs">${c.src.length} source${c.src.length > 1 ? 's' : ''} used ${c.src.map(mark).join('')}</div>
        <div class="action-req"><span class="label">${icon('paper', 15).outerHTML}${esc(c.act)}</span><span class="small ink2" style="margin-right:6px">See details</span><button class="btn btn-secondary btn-xs" type="button">Reject</button><button class="btn btn-primary btn-xs" type="button">Confirm</button></div>
      </div></div></div>`;
  };
  list.setAttribute('role', 'tablist');
  list.innerHTML = CAPS.map((c, i) => `<li role="tab" tabindex="0">${esc(c.t)}<span class="mono">${String(i + 1).padStart(2, '0')}</span></li>`).join('');
  list.querySelectorAll('li').forEach((li, i) => {
    li.addEventListener('click', () => show(i));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(i); } });
  });
  show(0);
}

function logoWall() {
  const wall = $('#logowall');
  if (!wall) return;
  wall.innerHTML = CONNECTORS.map((c) => `<div class="lw">
    ${logo(c)}
    <div><div class="nm">${esc(c.name)}</div><div class="rl">${esc(c.role)}</div></div>
    ${c.live ? '<span class="chip ok live"><span class="dot"></span>Tested live</span>' : ''}
  </div>`).join('');
}

function tiles(id, items) {
  const box = document.getElementById(id);
  if (!box) return;
  box.innerHTML = items.map((x) => `<div class="tile reveal"><div class="in">
    <span class="appico">${logo(x)}</span>
    <div class="nm">${esc(x.name)}${x.sub ? ` <span class="muted" style="font-weight:510">${esc(x.sub)}</span>` : ''}</div>
    <div class="rl">${esc(x.role)}</div></div></div>`).join('');
}

function reveal() {
  const els = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in-view')); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) { en.target.classList.add('in-view'); io.unobserve(en.target); }
  }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((e) => io.observe(e));
}

fillIcons();
nav();
heroReveal();
typeLoop($('#v-type'), ['Do we pass the insurance gate?', 'Draft the Lot 1 answers', 'Who is the buyer and what did they buy before?'], 2200);
floatCard();
caps();
logoWall();
tiles('models', MODELS);
tiles('agents', AGENTS);
fillIcons();
reveal();
