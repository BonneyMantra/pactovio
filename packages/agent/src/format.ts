/** Deterministic formatting. The model never does arithmetic: numbers shown to people are computed here. */
const SYMBOL: Record<string, string> = { EUR: '€', GBP: '£', USD: '$', INR: '₹' };

export function formatMoney(minor: number, currency = 'EUR'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (abs % 100).toString().padStart(2, '0');
  const sym = SYMBOL[currency] ?? `${currency} `;
  return `${sign}${sym}${whole}${cents === '00' ? '' : `.${cents}`}`;
}

export function formatEuros(whole: number | null | undefined): string {
  return whole == null ? 'value not stated' : formatMoney(whole * 100, 'EUR');
}

const MYT_MS = 8 * 3_600_000;
/** `19 Nov 2026, 14:00 GMT` style; deadlines are real tender times in UTC. */
export function formatDeadline(iso: string | null | undefined): string {
  if (!iso) return 'no deadline';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

export function daysUntil(iso: string, now: number): number {
  return (new Date(iso).getTime() - now) / 86_400_000;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export { MYT_MS };
