import { toRow } from '@pactovio/contracts';
import { chunkPages, CATALOG, KESTREL_WS, HARBOUR_WS, PRICE_RULES, r2KeyFor, type SampleFile } from '@pactovio/quote/samples';

const q = (v: string | number | null): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

function upsert(table: string, pk: string[], obj: Record<string, unknown>): string {
  const row = toRow(obj);
  const cols = Object.keys(row);
  const upd = cols.filter((c) => !pk.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => q(row[c]!)).join(', ')}) ON CONFLICT(${pk.join(', ')}) DO ${upd ? `UPDATE SET ${upd}` : 'NOTHING'};`;
}

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

export function evidenceSql(files: SampleFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const text = f.pages ? f.pages.map((p, i) => `[p.${i + 1}]\n${p.join('\n')}`).join('\n\n') : null;
    const r2 = r2KeyFor(f.workspace_id, f.filename);
    const isDs = f.kind === 'datasheet';
    let docId: string | null = null;
    if (isDs || f.kind === 'price_list') {
      docId = `doc_k_${f.id.replace('evd_k_', '')}`;
      out.push(upsert('documents', ['id'], { id: docId, tender_id: null, intake_id: null, workspace_id: f.workspace_id, filename: f.filename, kind: 'pdf', r2_key: r2, pages: f.pages?.length ?? null, text_r2_key: null, is_form: false }));
    }
    out.push(upsert('evidence', ['id'], { id: f.id, workspace_id: f.workspace_id, kind: f.kind, title: f.title, issuer: f.issuer, scope: f.scope, valid_to: f.valid_to, r2_key: r2, text, meta: { ...f.meta, filename: f.filename, mime: f.mime, doc_id: docId, pages: f.pages?.length ?? null } }));
    if (!f.pages) continue;
    const chunks = chunkPages(f.pages, isDs ? { prefix: String(f.meta.sku), perLine: true } : {});
    const ids = chunks.map((c) => `chk_${f.id.slice(4)}_${c.seq}_${hash(c.text)}`);
    chunks.forEach((c, i) => out.push(upsert('evidence_chunks', ['id'], { id: ids[i], evidence_id: f.id, workspace_id: f.workspace_id, seq: c.seq, text: c.text })));
    out.push(`DELETE FROM evidence_chunks WHERE evidence_id = ${q(f.id)} AND id NOT IN (${ids.map(q).join(', ')});`);
  }
  return out;
}

export function catalogSql(files: SampleFile[]): string[] {
  const out: string[] = [
    // Replace foundation's five placeholder products and their stale datasheet row with the full 10-product catalogue.
    `DELETE FROM products WHERE workspace_id = ${q(KESTREL_WS)} AND id LIKE 'prd_sample_%';`,
    `DELETE FROM evidence WHERE id = 'evd_sample_k_datasheet_vis200';`,
  ];
  for (const p of CATALOG) {
    const ds = files.find((f) => f.meta.product_id === p.id);
    out.push(upsert('products', ['id'], { id: p.id, workspace_id: KESTREL_WS, sku: p.sku, name: p.name, family: p.family, specs: { ...p.structured, unit: p.unit, prices: { EUR: p.eur, INR: p.inr }, spec_table: p.specs }, datasheet_doc_id: ds ? `doc_k_${ds.id.replace('evd_k_', '')}` : null, unit_price_minor: p.eur, currency: 'EUR' }));
  }
  for (const r of PRICE_RULES) out.push(upsert('price_rules', ['id'], { id: r.id, workspace_id: KESTREL_WS, kind: r.kind, rule: r.rule }));
  return out;
}

export { HARBOUR_WS, KESTREL_WS };
