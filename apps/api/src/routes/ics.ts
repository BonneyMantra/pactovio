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

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fold = (line: string) => line.match(/.{1,73}/g)?.join('\r\n ') ?? line;

/** Public root route `/ics/:token.ics`: deadlines of non-dismissed matched tenders as a calendar feed. */
export const icsRoutes = new Hono<AppEnv>().get('/ics/:file', async (c) => {
  const file = c.req.param('file');
  if (!file.endsWith('.ics')) return c.json({ error: 'Not found', code: 'not_found' }, 404);
  const ws = await c.env.CACHE.get(`ics:${file.slice(0, -4)}`);
  if (!ws) return c.json({ error: 'Unknown calendar token', code: 'not_found' }, 404);
  const items = await rows<{ id: string; title: string; buyer: string; deadline: string; url: string | null; fit_score: number }>(
    c.env.DB,
    `SELECT t.id, t.title, t.buyer, t.deadline, t.url, m.fit_score FROM tenders t JOIN tender_matches m ON m.tender_id = t.id
     WHERE m.workspace_id = ? AND m.status != 'dismissed' AND t.deadline IS NOT NULL ORDER BY t.deadline`,
    ws,
  );
  const now = stamp(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pactovio//Tender deadlines//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Pactovio tender deadlines'];
  for (const t of items) {
    const end = new Date(t.deadline);
    lines.push(
      'BEGIN:VEVENT', `UID:${t.id}@pactovio`, `DTSTAMP:${now}`, `DTSTART:${stamp(new Date(end.getTime() - 30 * 60_000))}`, `DTEND:${stamp(end)}`,
      fold(`SUMMARY:${esc(`Deadline: ${t.title}`)}`), fold(`DESCRIPTION:${esc(`${t.buyer}. Fit ${Math.round(t.fit_score)}%.${t.url ? ` ${t.url}` : ''}`)}`),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'DESCRIPTION:Tender closes tomorrow', 'END:VALARM', 'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n') + '\r\n', { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'public, max-age=300' } });
});
