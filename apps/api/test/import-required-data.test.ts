import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, mapping, product } from '../../../packages/integrations/test/fixture';
import { priceMinor, mapProduct } from '../src/lib/integration-input';
import { decodeHeaderSheet } from '../src/lib/integration-sheet';
import { sourceKey } from '../src/lib/integration-preview';
import { saveProduct, listProducts } from '../../../packages/quote/src/catalogue';
import { createQuote } from '../../../packages/quote/src/quote';
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{f=await fixture();},60000);
afterEach(()=>vi.restoreAllMocks());
afterAll(()=>f.dispose());
const approve=(j:any)=>({revision:j.revision,preview_hash:j.preview_hash,idempotency_key:crypto.randomUUID()});
async function stage(row:any,resource=crypto.randomUUID()){
 const r=await f.call('/imports/tabular',{resource,rows:[row],external_id_field:'external_id'});expect(r.status).toBe(201);return r.json() as Promise<any>;
}
async function preview(j:any,resolutions:any[]=[]){
 const r=await f.call(`/imports/${j.id}/preview`,{revision:j.revision,mapping,selected_ids:['required-data'],resolutions});expect(r.status).toBe(200);return r.json() as Promise<any>;
}
describe('source-linked completion and exact commercial boundary',()=>{
 it('keeps grouped decimals exact, rejects unknown/ambiguous formats and preserves explicit zero',()=>{
  expect(priceMinor('1,25,000.99','decimal')).toBe(12500099);expect(priceMinor('125,000.99','decimal')).toBe(12500099);
  for(const v of ['',null,'12,50','1.005','1e2','INR 99','-1'])expect(priceMinor(v,'decimal')).toBeNull();
  expect(priceMinor(0,'decimal')).toBe(0);expect(priceMinor('29','minor')).toBe(29);
 });
 it('requires an explicit decision when header currency conflicts with cells',()=>{
 const raw={...product(),'Buy INR':'50','Sell INR':'100',money:'USD'};
 const fields={...mapping,price:'Sell INR',cost:'Buy INR',currency:'money',cost_currency:'money',price_format:'decimal' as const};
 const result=mapProduct(raw,fields);expect(result.unresolved.sort()).toEqual(['cost_currency_conflict','currency_conflict']);
 expect(mapProduct(raw,fields,{currency:'USD',cost_currency:'USD'}).unresolved).toEqual([]);
 });
 it('reads native sheet headers and stable identities, excluding headers and retaining genuine gaps',async()=>{
  const rows=decodeHeaderSheet([['Customer Ref','Offering','Cost (INR)'],['rax-rt-rmc','Rack monitoring controller','']],{identity_column:'Customer Ref'});
  expect(rows).toEqual([{external_id:'rax-rt-rmc',source_version:null,record:{'Customer Ref':'rax-rt-rmc',Offering:'Rack monitoring controller','Cost (INR)':'',_source_id:'rax-rt-rmc'}}]);
  expect(()=>decodeHeaderSheet([['ID','ID'],['a','a']],{identity_column:'ID'})).toThrow();
  expect(()=>decodeHeaderSheet([['ID'],['a'],['a']],{identity_column:'ID'})).toThrow();
  const job:any={toolkit:'googlesheets',adapter:'googlesheets',account_id:'owned',resource_json:JSON.stringify({spreadsheet_id:'sheet',range:'Complete!A1:X61',header_row:true,identity_column:'source_id'})};
  const a=await sourceKey(job);job.resource_json=JSON.stringify({spreadsheet_id:'sheet',range:'Gaps!A1:X11',header_row:true,identity_column:'Record Ref'});expect(await sourceKey(job)).toBe(a);
 });
 it('stages missing cost without blocking grounded preview, blocks approval, then saves explicit completion privately',async()=>{
  const row={...product('required-data','RAX-REQ'),cost:'',features:'',technical_specs:''};
  const j=await stage(row),p=await preview(j),r=p.preview.rows[0];
  expect(r.product).toBeNull();expect(r.candidate).toMatchObject({name:row.name,unit_price_minor:1234});
  expect(r.unresolved).toEqual(['internal_unit_cost_minor']);expect(r.optional_gaps).toContain('technical_specs');
  expect(r.field_sources.internal_unit_cost_minor).toMatchObject({source_field:'cost',source_value:'',origin:'source'});
  expect((await f.call(`/imports/${j.id}/approve`,approve(p))).status).toBe(409);
  const done=await preview(p,[{external_id:'required-data',product:{internal_unit_cost_minor:777}}]);
  expect((await f.call(`/imports/${j.id}/approve`,approve(done))).status).toBe(200);
  const id=done.preview.rows[0].target_id;
  const raw=await f.env.DB.prepare('SELECT specs_json FROM products WHERE id=?').bind(id).first<any>();
  expect(raw.specs_json).not.toMatch(/cost|777/);
  expect(await f.env.DB.prepare('SELECT internal_unit_cost_minor FROM product_costs WHERE product_id=? AND workspace_id=?').bind(id,f.owner.workspace).first()).toEqual({internal_unit_cost_minor:777});
  const records=await listProducts(f.env.DB,f.owner.workspace);expect(records.find(r=>r.id===id)?.internal_unit_cost_minor).toBe(777);
  const quote=await createQuote(f.env,{workspaceId:f.owner.workspace,productIds:[id],qty:1});
  expect(JSON.stringify(quote)).not.toMatch(/777|internal_unit_cost|cost_currency|cost_unit/);
 });
 it('retains manual corrections and flags later sync conflicts without changing the product',async()=>{
  const resource=crypto.randomUUID(),j=await stage(product('required-data','RAX-EDIT'),resource),p=await preview(j);
  expect((await f.call(`/imports/${j.id}/approve`,approve(p))).status).toBe(200);const id=p.preview.rows[0].target_id;
  await saveProduct(f.env.DB,f.owner.workspace,{sku:'RAX-EDIT',name:'Corrected calibrated field laser',description:'Manually confirmed calibration reference',unit_price_minor:2000,currency:'MYR',unit:'piece',internal_unit_cost_minor:900,cost_currency:'MYR',cost_unit:'piece'},id);
  const next=await stage(product('required-data','RAX-EDIT','50'),resource),frozen=await preview(next);
  expect(frozen.preview.rows[0].unresolved).toContain('manual_edit_conflict');expect((await f.call(`/imports/${next.id}/approve`,approve(frozen))).status).toBe(409);
  expect(await f.env.DB.prepare('SELECT unit_price_minor FROM products WHERE id=?').bind(id).first()).toEqual({unit_price_minor:2000});
 });
 it('does not require a manufacturer SKU and requires confirmation for explicit zero amounts',async()=>{
  const row={...product('required-data','RAX-ZERO'),cost:0,price:0};delete (row as any).sku;
  const j=await stage(row);let p=await preview(j);expect(p.preview.rows[0].unresolved.sort()).toEqual(['zero_cost_confirmed','zero_price_confirmed']);
  p=await preview(p,[{external_id:'required-data',product:{zero_cost_confirmed:true,zero_price_confirmed:true}}]);
  expect(p.preview.rows[0].unresolved).toEqual([]);expect(p.preview.rows[0].product.sku).toMatch(/^PVI-/);
  expect((await f.call(`/imports/${j.id}/approve`,approve(p))).status).toBe(200);
  const r=await f.env.DB.prepare('SELECT specs_json FROM products WHERE id=?').bind(p.preview.rows[0].target_id).first<any>();expect(JSON.parse(r.specs_json).sku_origin).toBe('internal_reference');
 });
});
