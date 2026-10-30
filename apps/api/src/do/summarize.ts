import { clip } from '@pactovio/agent';

/** Keep tool output small enough for the model and the wire: long strings and arrays are trimmed, structure is kept. */
export function clipJson(v: unknown, maxChars: number): unknown {
  const s = JSON.stringify(v);
  if (s === undefined || s.length <= maxChars) return v;
  const trimmed = JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && x.length > 240 ? `${x.slice(0, 237)}...` : x))) as unknown;
  const s2 = JSON.stringify(trimmed);
  if (s2.length <= maxChars) return trimmed;
  if (trimmed && typeof trimmed === 'object' && !Array.isArray(trimmed)) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(trimmed as Record<string, unknown>)) o[k] = Array.isArray(val) ? val.slice(0, 8) : val;
    const s3 = JSON.stringify(o);
    if (s3.length <= maxChars) return { ...o, _truncated: true };
  }
  return { _truncated: true, preview: clip(s2, maxChars - 40) };
}

/** Deterministic one-line result of an executed action for the chat. No model involved. */
export function summarizeResult(tool: string, title: string, result: unknown): string {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  switch (tool) {
    case 'start_pack_run': return `Run started (${String(r.run_id ?? 'queued')})${r.replay ? ', showcase replay' : ''}. I will post here when the verdicts are ready.`;
    case 'draft_answers': return `Drafted ${String(r.drafted ?? 0)} answer${r.drafted === 1 ? '' : 's'}. They stay unapproved until you approve each one.`;
    case 'approve_answer': return `Approved answer ${String(r.question_ref ?? r.answer_id ?? '')}.`;
    case 'create_design_request_from_text': return `Design request created (${String(r.design_request_id)}). Start the spec match when you are ready.`;
    case 'match_design_request': return `Spec matched: ${Array.isArray(r.matches) ? r.matches.length : 0} product match${Array.isArray(r.matches) && r.matches.length === 1 ? '' : 'es'} found.`;
    case 'create_quote': return `Quote ${String(r.quote_id)} created${r.total ? `, total ${String(r.total)}` : ''}. It is a draft until you review it.`;
    case 'run_connector_action': return `${String(r.provider)} ${String(r.action)} ${r.ok ? 'done' : 'did not succeed'}.`;
    default: return `Done: ${title}`;
  }
}
