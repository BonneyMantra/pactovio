import type { Claim, Evidence } from '@pactovio/contracts';
import type { z } from 'zod';

type ClaimT = z.infer<typeof Claim>;
export type ClaimType = 'certification' | 'sla' | 'headcount' | 'client' | 'money' | 'date' | 'technology';
interface Token { type: ClaimType; key: string }

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNIT: Record<string, string> = { hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute', day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year' };
const HEAD_NOUN = '(?:staff|employees|engineers|developers|specialists|consultants|people|team members|testers|analysts|architects|designers|project managers|technicians)';

/** Lower-case, drop thousands separators, turn number words into digits ("six-week" -> "6 week"). */
export function normalise(s: string): string {
  let t = s.toLowerCase().replace(/[‘’]/g, "'").replace(/(\d),(\d{3})/g, '$1$2');
  t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred)\b(?=[\s-]+(?:hours?|minutes?|days?|weeks?|months?|years?|staff|engineers|developers|people|employees))/g, (w) => String(WORDS[w]));
  return t.replace(/(\d)-(week|day|hour|month|year|minute)/g, '$1 $2');
}

function moneyMinor(num: string, scale: string | undefined): number {
  const v = parseFloat(num);
  const mult = !scale ? 1 : /^(m|million)$/.test(scale) ? 1_000_000 : /^(bn|billion)$/.test(scale) ? 1e9 : 1000;
  return Math.round(v * mult * 100);
}

/** Extract checkable claim tokens from one piece of text. Pure and deterministic: no model involved. */
export function claimTokens(raw: string, clients: string[] = []): Token[] {
  const t = normalise(raw);
  const out: Token[] = [];
  const add = (type: ClaimType, key: string) => { if (!out.some((o) => o.type === type && o.key === key)) out.push({ type, key }); };

  for (const m of t.matchAll(/\biso(?:\/iec)?\s*(\d{4,5})/g)) add('certification', `iso${m[1]}`);
  for (const m of t.matchAll(/\b(soc\s?2|cyber essentials(?: plus)?|ce marking|rohs|pci[- ]dss|crest|itil|wcag\s?\d\.\d)\b/g)) add('certification', m[1]!.replace(/\s+/g, ' '));

  for (const m of t.matchAll(/\b24\s?[x×]\s?([57])\b/g)) add('sla', `24x${m[1]}`);
  for (const m of t.matchAll(/\b(\d{2,3}(?:\.\d+)?)\s?%/g)) add('sla', `${m[1]}%`);
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\b/g)) add('sla', `${m[1]} ${UNIT[m[2]!]}`);
  for (const m of t.matchAll(/\b(rto|rpo)\b[^.\d]{0,12}(\d+)/g)) add('sla', `${m[1]} ${m[2]}`);

  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,5})\\s*\\+?\\s*(?:full[- ]time\\s+)?${HEAD_NOUN}\\b`, 'g'))) add('headcount', m[1]!);

  for (const m of t.matchAll(/(?:€|eur\s?|£|gbp\s?|usd\s?|\$)\s?(\d+(?:\.\d+)?)\s?(million|m|bn|billion|k|thousand)?\b/g)) add('money', String(moneyMinor(m[1]!, m[2])));
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?)\s?(million|m|bn|billion|k)\s?(?:euro|eur)\b/g)) add('money', String(moneyMinor(m[1]!, m[2])));

  for (const m of t.matchAll(new RegExp(`\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(${MONTHS.join('|')})\\s+((?:19|20)\\d{2})\\b`, 'g'))) add('date', `${m[2]}-${String(MONTHS.indexOf(m[1]!) + 1).padStart(2, '0')}`);
  for (const m of t.matchAll(/\b((?:19|20)\d{2})\b/g)) add('date', m[1]!);

  // product and technology names the evidence must mention: CamelCase (ArcGIS, PostgreSQL, TypeScript) and versioned names (Java 21, Windows Server 2019)
  for (const m of raw.matchAll(/\b([A-Z][a-z]+[A-Z][A-Za-z]+|[A-Z]{2,}[a-z]+[A-Za-z]*|(?:Java|Python|Node|Windows Server|\.NET|Angular|React|SQL Server)\s?\d+(?:\.\d+)?)\b/g)) add('technology', m[1]!.toLowerCase().replace(/\s+/g, ' '));
  const named = raw.matchAll(/\b((?:[A-Z][\w&'-]+\s+){1,5}(?:Authority|Board|Council|University|Department|Commission|Ltd|Limited|Group|Agency|Observatory|Institute|College|Hospital|Operator|Plc|GmbH))\b/g);
  for (const m of named) {
    const k = m[1]!.toLowerCase();
    if (!clients.some((c) => k.includes(c) || c.includes(k))) add('client', k);
  }
  return out;
}

/** What the evidence supports: tokens of every type, plus date years implied by month-year keys. */
function evidenceKeys(ev: Evidence[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const e of ev) {
    const text = [e.title, e.issuer, e.scope, e.text].filter(Boolean).join('. ');
    const keys = claimTokens(text).map((t) => `${t.type}:${t.key}`);
    for (const k of keys) {
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(e.id);
    }
    const lower = normalise(text);
    for (const t of claimTokens(text)) if (t.type === 'client') m.get(`client:${t.key}`)?.add(e.id);
    m.set(`__text:${e.id}`, new Set([lower]));
  }
  return m;
}

export function splitSentences(text: string): string[] {
  // split after . ! ? followed by whitespace, so decimals ("9.8 million") and refs ("B1.1.1") stay intact
  return text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

export interface ClaimOptions { /** Names that may be mentioned freely: the bidder and the buyer. */ allow?: string[] }

/**
 * Split `text` into sentences and check every sentence that makes a checkable claim (certification, SLA or
 * duration, headcount, client name, money, date) against the evidence. A sentence is supported only when
 * EVERY claim token in it appears in at least one evidence item; evidence_ids lists the items that matched.
 */
export function claimCheckSync(text: string, evidence: Evidence[], opts: ClaimOptions = {}): ClaimT[] {
  const allow = (opts.allow ?? []).map((a) => a.toLowerCase());
  const keys = evidenceKeys(evidence);
  const claims: ClaimT[] = [];
  for (const sentence of splitSentences(text)) {
    const tokens = claimTokens(sentence, allow);
    if (!tokens.length) continue;
    const ids = new Set<string>();
    let supported = true;
    for (const tk of tokens) {
      const hit = keys.get(`${tk.type}:${tk.key}`);
      // client names: also accept a substring match in the raw evidence text (full legal names vary)
      const viaText = tk.type === 'client' ? evidence.filter((e) => normalise([e.title, e.text].join(' ')).includes(tk.key)).map((e) => e.id) : [];
      const found = [...(hit ?? []), ...viaText];
      if (!found.length) supported = false;
      found.forEach((id) => ids.add(id));
    }
    claims.push({ text: sentence, evidence_ids: supported ? [...ids] : [], supported });
  }
  return claims;
}

/** Async form kept for the cross-lane signature. */
export async function claimCheck(text: string, evidence: Evidence[], opts?: ClaimOptions): Promise<ClaimT[]> {
  return claimCheckSync(text, evidence, opts);
}

export const NEEDS_EVIDENCE_TAG = '[NEEDS_EVIDENCE';

/** Strike every unsupported sentence from the draft and leave a visible NEEDS_EVIDENCE flag naming what is missing. */
export function strikeUnsupported(draft: string, claims: ClaimT[]): string {
  let out = draft;
  for (const c of claims) {
    if (c.supported) continue;
    const missing = claimTokens(c.text).map((t) => `${t.type} ${t.key}`).slice(0, 4).join(', ');
    const flag = `${NEEDS_EVIDENCE_TAG}: unsupported claim removed (${missing})]`;
    const pattern = c.text.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    out = out.replace(new RegExp(pattern), () => flag);
  }
  return out;
}
