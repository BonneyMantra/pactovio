/** Small pure helpers shared by the provider action modules. */

/** First string or number found under any of `keys`, breadth-first, through nested objects and arrays. Composio wraps results in `response_data`/`data` layers that differ per toolkit. */
export function deepFind(data: unknown, keys: string[], maxDepth = 6): string | null {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  let level: unknown[] = [data];
  for (let d = 0; d <= maxDepth && level.length; d++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (Array.isArray(node)) next.push(...node);
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (want.has(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number') && String(v) !== '') return String(v);
          if (v && typeof v === 'object') next.push(v);
        }
      }
    }
    level = next;
  }
  return null;
}

/** Same walk, but returns the first array found under any of `keys`. */
export function deepFindArray(data: unknown, keys: string[], maxDepth = 6): unknown[] | null {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  let level: unknown[] = [data];
  for (let d = 0; d <= maxDepth && level.length; d++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (want.has(k.toLowerCase()) && Array.isArray(v)) return v;
          if (v && typeof v === 'object') next.push(v);
        }
      }
    }
    level = next;
  }
  return null;
}

/** Unwrap `{ response_data: X }` / `{ data: X }` layers. */
export function unwrap(data: unknown): unknown {
  let cur = data;
  for (let i = 0; i < 3; i++) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const o = cur as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length <= 3 && (o.response_data !== undefined || o.data !== undefined) && keys.every((k) => ['response_data', 'data', 'successful', 'error', 'status'].includes(k))) {
        cur = o.response_data ?? o.data;
        continue;
      }
    }
    break;
  }
  return cur;
}

export const ymd = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);
export const addDays = (d: Date | string, n: number): Date => new Date(new Date(d).getTime() + n * 86_400_000);
export const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
}

export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const MIME: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain',
  json: 'application/json', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', md: 'text/markdown',
};
export const mimeFor = (filename: string): string => MIME[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
