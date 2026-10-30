/**
 * D1 row <-> API entity mapping, shared by every lane.
 * Convention: a column `foo_json` is exposed as the parsed object `foo`;
 * INTEGER 0/1 flag columns (sample, is_form, replay, active) are exposed as booleans.
 */
const BOOL_COLS = new Set(['sample', 'is_form', 'replay', 'active']);

export function fromRow<T = Record<string, unknown>>(row: Record<string, unknown> | null | undefined): T {
  if (!row) return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_json')) {
      const key = k.slice(0, -5);
      out[key] = typeof v === 'string' ? safeParse(v) : (v ?? null);
    } else if (BOOL_COLS.has(k)) {
      out[k] = v === 1 || v === true;
    } else out[k] = v;
  }
  return out as T;
}

export function toRow(obj: Record<string, unknown>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object') out[`${k}_json`] = JSON.stringify(v);
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else out[k] = v as string | number | null;
  }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
