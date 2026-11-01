import { h, icon } from './ui.js';
import { requestCode, verifyCode, friendlyError } from './customer-api.js';

export function gateFrame() {
  document.body.classList.add('pv-gated');
  let gate = document.getElementById('access');
  if (!gate) { gate = h('main.access', { id: 'access' }); document.body.append(gate); }
  return gate;
}
export function leaveGate() { document.getElementById('access')?.remove(); document.body.classList.remove('pv-gated'); }
export function gateLayout(root, content, setup = false) {
  root.replaceChildren(h('header.access-header', h('a.brand', { href: '/' }, h('img', { src: '/assets/brand/mark.svg', alt: '', width: 26, height: 26 }), 'Pactovio'),
    h('a.small.ink2', { href: '/#how' }, 'How Pactovio works')),
  h(`div.access-layout${setup ? '.access-setup' : ''}`,
    h('aside.access-story', h('span.access-eyebrow', 'YOUR NEXT OPPORTUNITY, ANSWERED'), h('h1', 'Good work starts\nwith your company.'),
      h('p.ink2', 'Bring your requests, capabilities and evidence together. Pactovio helps you decide what to bid for, then drafts the response.'),
      h('div.access-promise', icon('shield', 20), h('div', h('strong.small', 'A workspace of your own'), h('p.small.ink2', 'Your company information and connections stay in your private workspace.')))), content),
    h('footer.access-footer.small.ink2', h('span', 'Pactovio · From request to response'), h('span', h('a', { href: '/privacy' }, 'Privacy'), ' · ', h('a', { href: '/terms' }, 'Terms'))));
}
export function gateError(root, error, retry) {
  gateLayout(root, h('section.card.access-card', h('span.access-step', 'CONNECTION INTERRUPTED'), h('h2.h2', 'Let’s try that again'),
    h('p.ink2', friendlyError(error)), h('button.btn.btn-primary', { onclick: retry }, icon('refresh'), 'Try again')));
}

export function renderAuth(root, onVerified, notice = '') {
  let email = '', step = 'email', retryAt = 0, expiresAt = 0, busy = false, disposed = false;
  let interval, status, form, resend, expiry, input, submit;
  const remaining = () => Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const fail = (e) => { status.textContent = friendlyError(e); status.className = 'access-status error-box'; status.focus(); };
  function tick() {
    if (step === 'email') { submit.disabled = busy || remaining() > 0; submit.firstChild.textContent = remaining() ? `Try again in ${remaining()}s` : 'Continue with email'; return; }
    if (!resend) return;
    resend.disabled = busy || remaining() > 0;
    resend.textContent = remaining() ? `Resend code in ${remaining()}s` : 'Resend code';
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    expiry.textContent = seconds ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'This code has expired. Request a new one below.';
    submit.disabled = busy || !seconds;
  }
  function setBusy(value) {
    busy = value; form.setAttribute('aria-busy', String(value));
    form.querySelectorAll('button, input').forEach((el) => { el.disabled = value; });
    tick();
  }
  async function send() {
    setBusy(true); status.textContent = 'Sending your code…';
    try {
      const result = await requestCode(email);
      if (disposed) return;
      retryAt = Date.now() + (result.retry_after || 60) * 1000;
      expiresAt = Date.now() + (result.expires_in || 600) * 1000;
      step = 'code'; draw(); status.textContent = 'Code sent. Check your inbox and spam folder.';
    } catch (e) {
      if (disposed) return;
      if (e.status === 429) retryAt = Date.now() + (e.retryAfter || 60) * 1000;
      fail(e);
    } finally { if (!disposed) setBusy(false); }
  }
  function draw() {
    clearInterval(interval); resend = null;
    status = h('div.access-status.small.ink2', { id: 'auth-status', role: 'status', 'aria-live': 'polite', tabindex: '-1' }, step === 'email' ? notice : '');
    input = step === 'email'
      ? h('input.input', { id: 'auth-email', name: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: 254, value: email, placeholder: 'you@company.com', 'aria-describedby': 'auth-status' })
      : h('input.input.access-code', { id: 'auth-code', name: 'code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', minlength: 6, maxlength: 6, required: true, placeholder: '000000', 'aria-describedby': 'code-expiry auth-status', oninput: (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); }, onpaste: (e) => { e.preventDefault(); e.target.value = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6); } });
    submit = h('button.btn.btn-primary.access-submit', { type: 'submit' }, step === 'email' ? 'Continue with email' : 'Verify & continue', icon('arrow'));
    form = h('form.access-form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); if (busy) return;
      if (step === 'email') {
        email = input.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status.textContent = 'Enter a valid email address, such as you@company.com.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        input.removeAttribute('aria-invalid'); await send(); return;
      }
      if (!/^[0-9]{6}$/.test(input.value)) { status.textContent = 'Enter the six-digit code from your latest email.'; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      input.removeAttribute('aria-invalid');
      const code = input.value; setBusy(true); status.textContent = 'Verifying your code…';
      try { await verifyCode(email, code); if (!disposed) await onVerified(); }
      catch (err) { if (!disposed) { fail(err); input.select(); } }
      finally { if (!disposed) setBusy(false); }
    } }, h('label.access-label', { for: input.id }, step === 'email' ? 'Work email' : 'Six-digit code'), input, submit, status);
    if (step === 'code') {
      expiry = h('div.small.ink2', { id: 'code-expiry' });
      resend = h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: send }, 'Resend code');
      form.append(expiry, h('div.access-code-actions', resend,
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { step = 'email'; draw(); } }, 'Change email')));
      tick();
    }
    gateLayout(root, h('section.card.access-card', h('span.access-step', step === 'email' ? 'SIGN IN OR CREATE AN ACCOUNT' : 'CHECK YOUR INBOX'),
      h('h2.h2', step === 'email' ? 'Welcome to Pactovio' : 'You’ve got a code'),
      h('p.ink2', step === 'email' ? 'Use your email to get started. We’ll send a sign-in code — no password to remember.' : ['Enter the code we sent to ', h('strong.access-email', email), '.']),
      form, step === 'email' ? h('p.xs.ink2.access-terms', 'By continuing, you agree to our ', h('a', { href: '/terms' }, 'Terms'), ' and ', h('a', { href: '/privacy' }, 'Privacy Policy'), '.') : null));
    interval = setInterval(tick, 1000); tick();
    input.focus();
  }
  draw();
  return () => { disposed = true; clearInterval(interval); root.replaceChildren(); };
}
