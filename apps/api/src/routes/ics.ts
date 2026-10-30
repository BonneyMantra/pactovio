import { Hono } from 'hono';
import { endpoints } from '@pactovio/contracts';
import { randomToken, rows } from '../lib/db';
import type { AppEnv } from '../lib/types';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.getIcsInfo, async ({ env, c, workspaceId }) => {
    let token = await env.CACHE.get(`ics_ws:${workspaceId}`);
    if (!token) {
      token = randomToken(16);
      await env.CACHE.put(`ics_ws:${workspaceId}`, token);
      await env.CACHE.put(`ics:${token}`, workspaceId);
    }
    return { token, url: `${new URL(c.req.url).origin}/ics/${token}.ics` };
  });
};

/** RFC 5545 TEXT escaping (backslash first, then ; , and newlines). */
export const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Fold at 70 characters (safely under 75 octets for mostly-ASCII text); continuation lines start with one space. */
export const fold = (line: string) => (line.match(/[\s\S]{1,70}/g) ?? [line]).join('\r\n ');

export interface IcsTender { id: string; title: string; buyer: string; deadline: string; url: string | null; fit_score: number; raw: Record<string, unknown> | null }

/** Extra dates we know how to read from `tenders.raw`: clarification windows, site visits, award. Also `raw.key_dates: [{label, at}]`. */
const KEY_DATES: [string, string][] = [
  ['queries_close', 'Clarification questions close'], ['clarification_deadline', 'Clarification questions close'], ['clarifications_close', 'Clarification questions close'],
  ['site_visit', 'Site visit'], ['award_date', 'Expected award'],
];

export function keyDates(raw: Record<string, unknown> | null): { key: string; label: string; at: Date }[] {
  const out: { key: string; label: string; at: Date }[] = [];
  const add = (key: string, label: string, v: unknown) => { const d = typeof v === 'string' ? new Date(v) : null; if (d && !Number.isNaN(d.getTime())) out.push({ key, label, at: d }); };
  for (const [k, label] of KEY_DATES) add(k, label, raw?.[k]);
  const kd = raw?.key_dates;
  if (Array.isArray(kd)) kd.forEach((x, i) => { if (x && typeof x === 'object') add(`kd${i}`, String((x as { label?: unknown }).label ?? 'Key date'), (x as { at?: unknown }).at); });
  return out;
}

function vevent(uid: string, now: string, start: Date, end: Date, summary: string, desc: string, alarm: string): string[] {
  return ['BEGIN:VEVENT', `UID:${uid}@pactovio`, `DTSTAMP:${now}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, fold(`SUMMARY:${esc(summary)}`), fold(`DESCRIPTION:${esc(desc)}`),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', `DESCRIPTION:${esc(alarm)}`, 'END:VALARM', 'END:VEVENT'];
}

export function buildIcs(items: IcsTender[], nowDate = new Date()): string {
  const now = stamp(nowDate);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pactovio//Tender deadlines//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Pactovio tender deadlines'];
  for (const t of items) {
    const info = `${t.buyer}. Fit ${Math.round(t.fit_score)}%.${t.url ? ` ${t.url}` : ''}`;
    const end = new Date(t.deadline);
    if (!Number.isNaN(end.getTime())) lines.push(...vevent(t.id, now, new Date(end.getTime() - 30 * 60_000), end, `Deadline: ${t.title}`, info, 'Tender closes tomorrow'));
    for (const k of keyDates(t.raw)) lines.push(...vevent(`${t.id}-${k.key}`, now, new Date(k.at.getTime() - 30 * 60_000), k.at, `${k.label}: ${t.title}`, info, `${k.label} tomorrow`));
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** Public root route `/ics/:token.ics`: deadlines and clarification dates of non-dismissed matched tenders as a calendar feed. */
export const icsRoutes = new Hono<AppEnv>().get('/ics/:file', async (c) => {
  const file = c.req.param('file');
  if (!/^[a-f0-9]{16,64}\.ics$/.test(file)) return c.json({ error: 'Not found', code: 'not_found' }, 404);
  const ws = await c.env.CACHE.get(`ics:${file.slice(0, -4)}`);
  if (!ws) return c.json({ error: 'Unknown calendar token', code: 'not_found' }, 404);
  const items = await rows<IcsTender>(
    c.env.DB,
    `SELECT t.id, t.title, t.buyer, t.deadline, t.url, m.fit_score, t.raw_json FROM tenders t JOIN tender_matches m ON m.tender_id = t.id
     WHERE m.workspace_id = ? AND m.status != 'dismissed' AND t.deadline IS NOT NULL ORDER BY t.deadline`,
    ws,
  );
  return new Response(buildIcs(items), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'public, max-age=300' } });
});
