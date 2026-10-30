import { clip, formatDeadline, formatMoney, plural } from './format';

export interface ProactiveAction {
  tool: string;
  input: Record<string, unknown>;
  title: string;
  detail: string;
}
export interface ProactiveMessage {
  event_id: string;
  event_type: string;
  text: string;
  action?: ProactiveAction;
}
export interface EventLike {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

const str = (p: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
};
const num = (p: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
};

/**
 * Turn a domain event into a proactive agent message, optionally with an action request the user can confirm.
 * Pure: tender titles etc. must already be in the payload (the hub enriches it from D1 first).
 * Returns null for events that are noise in a chat (run.step, run.started, billing.updated ...).
 */
export function mapEvent(e: EventLike): ProactiveMessage | null {
  const p = e.payload ?? {};
  const base = { event_id: e.id, event_type: e.type };
  const tenderId = str(p, 'tender_id');
  const title = str(p, 'title', 'tender_title', 'subject') ?? tenderId ?? 'a tender';

  switch (e.type) {
    case 'tender.matched': {
      const fit = num(p, 'fit_score', 'fit');
      const bits = [str(p, 'buyer'), p.deadline ? `closes ${formatDeadline(String(p.deadline))}` : undefined].filter(Boolean).join(', ');
      return {
        ...base,
        text: `New match: ${clip(title, 120)}${fit !== undefined ? `, fit ${Math.round(fit)}` : ''}.${bits ? ` ${bits}.` : ''} Read the pack?`,
        ...(tenderId ? { action: { tool: 'start_pack_run', input: { tender_id: tenderId }, title: 'Read the pack?', detail: `${clip(title, 120)}${fit !== undefined ? `, fit ${Math.round(fit)}` : ''}. Reads every document, builds the requirement matrix and the per-lot verdicts.` } } : {}),
      };
    }
    case 'intake.classified': {
      const door = str(p, 'door') ?? (p.classification as { door?: string } | undefined)?.door;
      if (!door || door === 'ignore') return null;
      const sender = str(p, 'sender', 'from');
      const from = sender ? ` from ${sender}` : '';
      const dsg = str(p, 'design_request_id');
      if (door === 'design') {
        return {
          ...base,
          text: `New design request${from}: ${clip(title, 120)}. Start spec match?`,
          ...(dsg ? { action: { tool: 'match_design_request', input: { design_request_id: dsg }, title: 'Start spec match?', detail: `${clip(title, 120)}${from}. Reads the spec and matches it against your product catalogue.` } } : {}),
        };
      }
      const kind = door === 'rfp' ? 'RFP/RFQ' : 'tender';
      return {
        ...base,
        text: `New ${kind}${from}: ${clip(title, 120)}. Start the pack read?`,
        ...(tenderId ? { action: { tool: 'start_pack_run', input: { tender_id: tenderId }, title: 'Start the pack read?', detail: `${clip(title, 120)}${from}.` } } : {}),
      };
    }
    case 'verdict.ready': {
      const decision = str(p, 'decision');
      const score = num(p, 'score');
      const lot = str(p, 'lot');
      const text = `Verdict ready for ${clip(title, 100)}${lot ? `, lot ${lot}` : ''}${decision ? `: ${decision.replace('_', '-')}` : ''}${score !== undefined ? ` (score ${Math.round(score)})` : ''}.`;
      const bid = decision === 'BID' || decision === 'CONDITIONAL';
      return {
        ...base,
        text: bid ? `${text} Draft the answers?` : text,
        ...(bid && tenderId ? { action: { tool: 'draft_answers', input: { tender_id: tenderId, ...(lot ? { lot } : {}) }, title: 'Draft the answers?', detail: `${clip(title, 100)}${lot ? `, lot ${lot}` : ''}. Drafts are claim-checked and stay unapproved until you approve each one.` } } : {}),
      };
    }
    case 'approval.requested': {
      const answerId = str(p, 'answer_id');
      const ref = str(p, 'question_ref', 'ref');
      return {
        ...base,
        text: `An answer needs your approval${ref ? `: ${ref}` : ''} on ${clip(title, 100)}.`,
        ...(answerId ? { action: { tool: 'approve_answer', input: { answer_id: answerId }, title: `Approve answer${ref ? ` ${ref}` : ''}?`, detail: clip(str(p, 'draft', 'summary') ?? title, 200) } } : {}),
      };
    }
    case 'audit.completed': {
      const status = str(p, 'status') ?? 'completed';
      const summary = str(p, 'summary');
      const flags = num(p, 'flags', 'flag_count', 'violations');
      return { ...base, text: `Guardrails audit ${status}${tenderId ? ` for ${clip(title, 100)}` : ''}.${summary ? ` ${clip(summary, 200)}` : flags !== undefined ? ` ${plural(flags, 'issue')} flagged.` : ''}` };
    }
    case 'certificate.expiring': {
      const days = num(p, 'days_left');
      return { ...base, text: `Certificate expiring: ${clip(str(p, 'title', 'name') ?? 'a certificate', 100)}${str(p, 'valid_to') ? ` ends ${str(p, 'valid_to')}` : ''}${days !== undefined ? ` (${plural(Math.round(days), 'day')})` : ''}. Upload a renewed certificate to keep bids eligible.` };
    }
    case 'quote.ready': {
      const total = num(p, 'total_minor');
      const cur = str(p, 'currency') ?? 'EUR';
      const customer = str(p, 'customer');
      return { ...base, text: `Quote ready${customer ? ` for ${customer}` : ''}${total !== undefined ? `: ${formatMoney(total, cur)}` : ''}. Review it on the Quotes page before it goes out.` };
    }
    case 'run.completed': {
      if (str(p, 'status') === 'failed') return { ...base, text: `The pack run for ${clip(title, 100)} failed${str(p, 'error') ? `: ${clip(str(p, 'error')!, 160)}` : ''}.` };
      return { ...base, text: `Pack run finished for ${clip(title, 100)}${p.replay ? ' (showcase replay)' : ''}.` };
    }
    default:
      return null;
  }
}
