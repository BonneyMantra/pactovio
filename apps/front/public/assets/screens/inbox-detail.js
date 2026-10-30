// One intake: classification card, the original message, and where it went next. `#/inbox/new` is the composer.
import { api, h, icon, fmt, chip, toast, errorBox, skeleton } from '../ui.js';
import { dash, val, doorChip, sourceMark, senderName } from './work-kit.js';

function composer(root, ctx) {
  ctx.setCrumbs(h('a', { href: '#/inbox' }, 'Inbox'), 'New intake');
  const title = h('input.input', { placeholder: 'Subject, e.g. RFQ: 40 environmental sensors for berth kiosks' });
  const sender = h('input.input', { placeholder: 'From, e.g. Procurement, Harbourview Port <buy@harbourview-port.example>' });
  const text = h('textarea.input', { rows: 10, placeholder: 'Paste the email or request text. Pactovio classifies it as an RFQ, RFP, design request or tender and starts the right workflow.' });
  const btn = h('button.btn.btn-primary', { type: 'submit' }, icon('send'), 'Classify and start');
  const form = h('form.card.wk-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!text.value.trim()) { toast('Paste the request text first'); return; }
      btn.disabled = true; btn.lastChild.textContent = 'Classifying…';
      try {
        const r = await api('/intakes', { method: 'POST', body: { title: title.value.trim() || undefined, sender: sender.value.trim() || undefined, text: text.value.trim() } });
        toast('Intake created, classifying now');
        location.hash = `#/inbox/${encodeURIComponent(r.intake_id)}`;
      } catch (err) { toast(err.message); btn.disabled = false; btn.lastChild.textContent = 'Classify and start'; }
    },
  }, h('label.wk-field', h('span.xs.muted', 'Subject'), title), h('label.wk-field', h('span.xs.muted', 'From'), sender), h('label.wk-field', h('span.xs.muted', 'Message'), text), h('div.wk-form-foot', h('span.xs.muted', 'Classified by Nemotron Lightning on Nebius Token Factory'), btn));
  root.append(h('div.page-head', h('div', h('h1.title', 'New intake'), h('div.sub', 'Paste anything a customer sent. The same pipeline runs for live Gmail mail.'))), form);
}

function kv(k, v) { return h('div.wk-kv', h('span.xs.muted', k), h('span.small', v)); }

export async function render(root, { id }, ctx) {
  if (id === 'new') return composer(root, ctx);
  ctx.setCrumbs(h('a', { href: '#/inbox' }, 'Inbox'), 'Intake');
  root.append(skeleton(6));
  let d;
  const fetchIt = async () => (d = await api(`/intakes/${encodeURIComponent(id)}`));
  try { await fetchIt(); } catch (e) { root.replaceChildren(errorBox(e)); return; }
  let timer = null;
  const draw = async () => {
    const it = d.intake || {};
    const cls = it.classification || {};
    ctx.setCrumbs(h('a', { href: '#/inbox' }, 'Inbox'), it.title || 'Intake');
    let spec = null;
    if (it.design_request_id) { try { spec = await api(`/design-requests/${encodeURIComponent(it.design_request_id)}`); } catch { spec = null; } }
    const next = it.design_request_id
      ? h('a.action-req', { href: `#/quotes/${encodeURIComponent(it.design_request_id)}` }, h('span.label', icon('quote'), `Design request${spec?.customer ? ` from ${spec.customer}` : ''}: match products and quote`), h('span.btn.btn-primary.btn-xs', 'Open', icon('arrow', 14)))
      : it.tender_id
        ? h('a.action-req', { href: `#/tenders/${encodeURIComponent(it.tender_id)}` }, h('span.label', icon('tender'), 'Tender created: read the pack and decide'), h('span.btn.btn-primary.btn-xs', 'Open', icon('arrow', 14)))
        : it.status === 'ignored' ? h('div.small.muted', 'Not a procurement or design request, so nothing was started.') : h('div.small.muted', it.status === 'processing' ? 'Still processing…' : 'No workflow started yet.');
    root.replaceChildren(
      h('div.wk-mailhead', sourceMark(it.source, 40), h('div', { style: { minWidth: 0 } },
        h('h1.title.wk-break', it.title || '(no subject)'),
        h('div.small.muted', `${senderName(it.sender)} · ${fmt.dateTime(it.received_at)} · via ${val(it.source)}`)), h('div.wk-grow'), doorChip(it)),
      h('div.wk-two',
        h('div.card.wk-pad', h('div.xs.muted', { style: { marginBottom: '8px' } }, 'Message'),
          spec?.spec_text ? h('div.wk-message', spec.spec_text) : h('div.small.muted', (d.documents || []).length ? `${d.documents.length} file${d.documents.length === 1 ? '' : 's'} stored with this intake.` : 'The message body is stored with the intake; no attachments.'),
          (d.documents || []).length ? h('div.wk-docs', d.documents.map((doc) => h('span.chip.outline', icon('file', 12), doc.filename || doc.id))) : null),
        h('div', { style: { display: 'grid', gap: '16px', alignContent: 'start' } },
          h('div.card.wk-pad', h('div.wk-cls-head', icon('spark'), h('span.small', { style: { fontWeight: 510 } }, 'Classification')),
            kv('Door', doorChip(it)), kv('Confidence', cls.confidence != null ? `${Math.round(cls.confidence * 100)}%` : dash), kv('Customer', val(cls.customer || spec?.customer)), kv('Status', chip(it.status || 'new')),
            h('div.small.ink2', { style: { marginTop: '10px' } }, cls.reason || dash)),
          h('div', next))),
    );
    clearTimeout(timer);
    if (it.status === 'processing' || it.status === 'received') timer = setTimeout(async () => { try { await fetchIt(); draw(); } catch { /* retry next tick */ } }, 4000);
  };
  await draw();
  return () => clearTimeout(timer);
}
