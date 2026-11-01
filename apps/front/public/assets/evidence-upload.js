import { h, icon } from './ui.js';
import { EVIDENCE_KINDS, EVIDENCE_ACCEPT, validateEvidence, uploadEvidence, uploadError } from './evidence-upload-api.js';
const LABELS = { datasheet: 'Datasheet', certificate: 'Certificate', insurance: 'Insurance', case_study: 'Case study', other: 'Other' };

export function evidenceUpload(onAccepted, refreshList) {
  let files = [], kind = '', busy = false, disposed = false, controller;
  const status = h('div.access-status.small.ink2', { id: 'evidence-upload-status', role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const chosen = h('div.small.ink2.evidence-filename', { id: 'evidence-file-name' }, 'No file selected');
  const file = h('input', { type: 'file', id: 'evidence-file', accept: EVIDENCE_ACCEPT, hidden: true, 'aria-label': 'Evidence file', onchange: () => {
    files = [...file.files];
    chosen.textContent = files.length === 1 ? `${files[0].name} · ${(files[0].size / 1024 / 1024).toFixed(2)} MB` : files.length ? `${files.length} files selected — choose one file` : 'No file selected';
    status.textContent = ''; choose.textContent = files.length ? 'Change file' : 'Choose file';
  } });
  const choose = h('button.btn.btn-secondary', { type: 'button', 'aria-describedby': 'evidence-file-name evidence-file-help', onclick: () => file.click() }, icon('clip'), 'Choose file');
  const title = h('input.input', { id: 'evidence-title', maxlength: 200, placeholder: 'Optional — use the document title' });
  const expiry = h('input.input', { id: 'evidence-expiry', type: 'text', inputmode: 'numeric', maxlength: 10, placeholder: 'YYYY-MM-DD', 'aria-describedby': 'evidence-expiry-help' });
  const kinds = h('div.evidence-kinds', { role: 'group', 'aria-labelledby': 'evidence-kind-label' });
  for (const id of EVIDENCE_KINDS) kinds.append(h('button.btn.btn-secondary.btn-sm', { type: 'button', 'aria-pressed': 'false', onclick: () => {
    kind = id; [...kinds.children].forEach((el, i) => el.setAttribute('aria-pressed', String(EVIDENCE_KINDS[i] === id)));
  } }, LABELS[id]));
  const submit = h('button.btn.btn-primary', { type: 'submit' }, icon('paper'), 'Upload & read document');
  const refresh = h('button.btn.btn-ghost', { type: 'button', onclick: refreshList }, icon('refresh'), 'Refresh evidence list');
  const form = h('form.company-form', { novalidate: true, onsubmit: async (event) => {
    event.preventDefault(); if (busy) return;
    const details = { title: title.value.trim(), kind, validTo: expiry.value.trim() };
    const invalid = validateEvidence(files, details);
    if (invalid) { status.textContent = invalid; status.classList.add('field-error'); status.focus(); return; }
    busy = true; controller = new AbortController(); form.setAttribute('aria-busy', 'true');
    form.querySelectorAll('button,input').forEach((el) => { el.disabled = true; });
    status.classList.remove('field-error'); status.textContent = 'Uploading and reading your document. Keep this page open until it finishes.';
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const accepted = await uploadEvidence(files, details, controller.signal);
      if (disposed) return;
      status.textContent = `Document ready. “${details.title || files[0].name}” was added to your evidence.`;
      files = []; file.value = ''; title.value = ''; expiry.value = ''; kind = '';
      chosen.textContent = 'No file selected'; choose.textContent = 'Choose file';
      [...kinds.children].forEach((el) => el.setAttribute('aria-pressed', 'false'));
      status.focus(); await onAccepted(accepted);
    } catch (error) { if (!disposed) { status.textContent = uploadError(error); status.classList.add('field-error'); status.focus(); } }
    finally {
      clearTimeout(timeout); busy = false;
      if (!disposed) { form.setAttribute('aria-busy', 'false'); form.querySelectorAll('button,input').forEach((el) => { el.disabled = false; }); }
    }
  } }, h('h2.h3', 'Add company evidence'),
    h('p.small.ink2', 'Upload one document. Pactovio reads and indexes its contents so you can use it in matching and drafts.'),
    h('div.evidence-file-row', file, choose, chosen),
    h('div.xs.ink2', { id: 'evidence-file-help' }, 'PDF, DOCX, PNG, JPG, WebP or TXT · up to 12 MB'),
    h('div.access-field', h('span.access-label', { id: 'evidence-kind-label' }, 'Evidence type'), kinds,
      h('span.xs.ink2', 'Choose Datasheet for product specifications used in design matching.')),
    h('div.access-field', h('label.access-label', { for: title.id }, 'Title · optional'), title),
    h('div.access-field', h('label.access-label', { for: expiry.id }, 'Valid until · optional'), expiry,
      h('span.xs.ink2', { id: 'evidence-expiry-help' }, 'Enter the expiry printed on the document, for example 2027-06-30.')),
    status, h('div.company-actions', refresh, submit));
  return { element: h('section.card.company-settings.evidence-upload', form), focus: () => choose.focus(), dispose: () => { disposed = true; controller?.abort(); } };
}
