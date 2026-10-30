import { clip, formatDeadline, formatMoney, plural, MYT_MS } from './format';
import type { ProactiveAction } from './events-map';

/** Morning digest at 06:30 MYT = 22:30 UTC the day before. */
export const DIGEST_UTC = { hour: 22, minute: 30 } as const;
export const DEADLINE_DAYS = [7, 2, 1] as const;
export const CERT_DAYS = [60, 30, 7] as const;

export function nextDigestAt(now: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DIGEST_UTC.hour, DIGEST_UTC.minute, 0, 0);
  return t > now + 1000 ? t : t + 86_400_000;
}

export function mytDate(now: number): string {
  return new Date(now + MYT_MS).toISOString().slice(0, 10);
}

export interface Reminder { key: string; text: string }

/** Smallest threshold that `days` has crossed (days <= t), or null if beyond the largest or already past. */
export function bucket(days: number, thresholds: readonly number[]): number | null {
  if (days <= 0) return null;
  const ordered = [...thresholds].sort((a, b) => a - b);
  return ordered.find((t) => days <= t) ?? null;
}

const human = (days: number) => (days < 1.5 ? `${Math.max(1, Math.round(days * 24))} hours` : plural(Math.round(days), 'day'));

/** Deadline reminders at 7/2/1 days. Each (tender, threshold) fires once; `sent` holds keys already used. */
export function dueDeadlineReminders(tenders: { tender_id: string; title: string; deadline: string }[], now: number, sent: Set<string>): Reminder[] {
  const out: Reminder[] = [];
  for (const t of tenders) {
    const days = (new Date(t.deadline).getTime() - now) / 86_400_000;
    const b = bucket(days, DEADLINE_DAYS);
    if (b === null) continue;
    const key = `deadline:${t.tender_id}:${b}`;
    if (sent.has(key)) continue;
    out.push({ key, text: `Deadline in ${human(days)}: ${clip(t.title, 110)} closes ${formatDeadline(t.deadline)}.` });
  }
  return out;
}

/** Certificate expiry nudges at 60/30/7 days, plus once when expired. */
export function dueCertificateNudges(certs: { evidence_id: string; title: string; valid_to: string }[], now: number, sent: Set<string>): Reminder[] {
  const out: Reminder[] = [];
  for (const c of certs) {
    const end = new Date(`${c.valid_to.slice(0, 10)}T23:59:59Z`).getTime();
    const days = (end - now) / 86_400_000;
    const expired = days <= 0;
    const b = expired ? 0 : bucket(days, CERT_DAYS);
    if (b === null) continue;
    const key = `cert:${c.evidence_id}:${b}`;
    if (sent.has(key)) continue;
    out.push({
      key,
      text: expired
        ? `Certificate expired: ${clip(c.title, 100)} ended ${c.valid_to.slice(0, 10)}. Bids that rely on it will be flagged until a renewal is uploaded.`
        : `Certificate expiring in ${plural(Math.ceil(days), 'day')}: ${clip(c.title, 100)} ends ${c.valid_to.slice(0, 10)}. Upload the renewal to keep bids eligible.`,
    });
  }
  return out;
}

export interface TodayLike {
  new_matches: number;
  open_intakes: number;
  answers_awaiting_approval: number;
  top_matches: { tender_id: string; title: string; fit_score: number; status: string; deadline: string | null }[];
  closing_soon: { tender_id: string; title: string; deadline: string; days_left: number }[];
  expiring_certificates: { title: string; valid_to: string; days_left: number }[];
}

/** Compose the 06:30 digest text and, when a new match exists, an action to read its pack. All numbers come from the data, not a model. */
export function renderDigest(t: TodayLike, workspaceName: string, now: number): { text: string; action?: ProactiveAction } {
  const lines = [`Good morning. Pactovio digest for ${workspaceName}, ${mytDate(now)}.`];
  lines.push(`${plural(t.new_matches, 'new match', 'new matches')}, ${plural(t.open_intakes, 'open intake')}, ${plural(t.answers_awaiting_approval, 'answer')} awaiting your approval.`);
  const week = t.closing_soon.filter((c) => c.days_left <= 7);
  if (week.length) lines.push(`Closing within 7 days: ${week.map((c) => `${clip(c.title, 60)} (${formatDeadline(c.deadline)})`).join('; ')}.`);
  if (t.expiring_certificates.length) lines.push(`Certificates to renew: ${t.expiring_certificates.slice(0, 3).map((c) => `${clip(c.title, 50)} (${c.valid_to.slice(0, 10)})`).join('; ')}.`);
  const top = t.top_matches.find((m) => m.status === 'new') ?? null;
  if (top) lines.push(`Best new match: ${clip(top.title, 90)}, fit ${Math.round(top.fit_score)}. Read the pack?`);
  return {
    text: lines.join(' '),
    ...(top ? { action: { tool: 'start_pack_run', input: { tender_id: top.tender_id }, title: 'Read the pack?', detail: `${clip(top.title, 100)}, fit ${Math.round(top.fit_score)}.` } } : {}),
  };
}

export { formatMoney };
