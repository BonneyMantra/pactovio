export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whole euros from minor units, e.g. 897000000 -> "EUR 8,970,000". Pure formatting, no arithmetic on the model side. */
export function eurFromMinor(minor: number): string {
  return `EUR ${Math.round(minor / 100).toLocaleString('en-IE')}`;
}

export const nowIso = () => new Date().toISOString();

export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** Run `fn` over `items` with at most `n` in flight; preserves order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
