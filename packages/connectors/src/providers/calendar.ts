import { need, type ProviderActions } from '../actions';
import { addDays, deepFind, ymd } from '../util';

/** `2026-11-19T14:00:00Z` -> `2026-11-19T14:00:00` (naive, paired with time zone UTC). */
const naive = (d: Date) => d.toISOString().slice(0, 19);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

interface Window { allDay: boolean; start: Date; end: Date }

/** `all_day: true` (or a bare YYYY-MM-DD `start`) gives an all-day event; otherwise a 30 minute event at `start`. */
export function eventWindow(i: Record<string, any>): Window { // eslint-disable-line @typescript-eslint/no-explicit-any
  const startRaw = String(need(i.start, 'start'));
  const allDay = i.all_day === true || /^\d{4}-\d{2}-\d{2}$/.test(startRaw);
  const start = new Date(allDay ? `${startRaw.slice(0, 10)}T00:00:00Z` : startRaw);
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid start: ${startRaw}`);
  const end = allDay ? addDays(start, 1) : i.end ? new Date(String(i.end)) : new Date(start.getTime() + 30 * 60_000);
  return { allDay, start, end };
}

const SAMPLE = () => ({ title: 'Pactovio connector test event', start: inDays(30).toISOString(), description: 'Created by the Pactovio connector test.' });

export const googlecalendar: ProviderActions = {
  create_event: {
    summary: 'Create a calendar event (timed or all-day)',
    run: async (i, ctx) => {
      const w = eventWindow(i);
      const data = await ctx.exec('GOOGLECALENDAR_CREATE_EVENT', {
        summary: need(i.title, 'title'),
        ...(w.allDay ? { start_date: ymd(w.start), end_date: ymd(w.end) } : { start_datetime: naive(w.start), end_datetime: naive(w.end), timezone: 'UTC' }),
        ...(i.description ? { description: String(i.description).slice(0, 8000) } : {}),
        create_meeting_room: false, send_updates: 'none', exclude_organizer: false,
      });
      const id = deepFind(data, ['id', 'event_id']);
      return { id, url: deepFind(data, ['htmlLink', 'html_link']) };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('GOOGLECALENDAR_EVENTS_GET', { event_id: out.id }), ['id']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('GOOGLECALENDAR_DELETE_EVENT', { event_id: out.id, send_updates: 'none' }); },
    sample: SAMPLE,
  },
};

export const outlook_calendar: ProviderActions = {
  create_event: {
    summary: 'Create a calendar event (timed or all-day)',
    run: async (i, ctx) => {
      const w = eventWindow(i);
      const data = await ctx.exec('OUTLOOK_CALENDAR_CREATE_EVENT', {
        subject: need(i.title, 'title'), start_datetime: naive(w.start), end_datetime: naive(w.end), time_zone: 'UTC', is_all_day: w.allDay,
        ...(i.description ? { body: String(i.description).slice(0, 8000), is_html: false } : {}),
      });
      const id = deepFind(data, ['id']);
      return { id, url: deepFind(data, ['webLink']) };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('OUTLOOK_GET_EVENT', { event_id: out.id }), ['id']) !== null,
    cleanup: async (out, ctx) => { if (out.id) await ctx.exec('OUTLOOK_DELETE_EVENT', { event_id: out.id }); },
    sample: SAMPLE,
  },
};
