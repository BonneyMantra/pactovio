import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, product } from '../../../packages/integrations/test/fixture';
let f:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{f=await fixture();},60000);
afterEach(()=>vi.restoreAllMocks());afterAll(()=>f.dispose());
async function staged(){const r=await f.call('/imports/tabular',{resource:crypto.randomUUID(),external_id_field:'external_id',rows:[{...product(), 'Purchase cost INR':'1,25,000.00','Customer price INR':'1,75,000.00'}]});expect(r.status).toBe(201);return r.json() as Promise<any>;}
const content=(source_field='Purchase cost INR')=>({suggestions:[{field:'cost',source_field,confidence:.94,reason:'Explicit purchase cost header'},{field:'price',source_field:'Customer price INR',confidence:.95,reason:'Explicit customer selling amount header'}],questions:[],selling_currency_hint:'INR',cost_currency_hint:'INR'});
function model(data:unknown){return vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
 expect(String(url)).toContain('api.tokenfactory.nebius.com');const body=JSON.parse(String(init?.body));expect(body.model).toBe('nvidia/Nemotron-3_5-Lightning');expect(body.chat_template_kwargs).toEqual({enable_thinking:false});expect(body.tools).toBeUndefined();expect(JSON.stringify(body.messages)).not.toContain('1,25,000.00');expect(JSON.stringify(body.messages)).not.toContain('1,75,000.00');
 return new Response(JSON.stringify({id:'fixture-completion',choices:[{message:{role:'assistant',content:JSON.stringify(data)},finish_reason:'stop'}],usage:{prompt_tokens:400,completion_tokens:100}}),{headers:{'content-type':'application/json'}});
});}
describe('real model contract with transport fixtures, never live spend',()=>{
 it('preserves staging and offers manual completion when kill switch refuses inference',async()=>{
 const j=await staged(),spy=vi.spyOn(globalThis,'fetch');const r=await f.call(`/imports/${j.id}/normalize`,{revision:0});expect(r.status).toBe(402);expect(await r.json()).toMatchObject({code:'model_limit'});expect(spy).not.toHaveBeenCalled();expect(await (await f.call(`/imports/${j.id}`)).json()).toMatchObject({state:'staged',revision:0,staged:1});
 });
 it('requires owned auth and current revision before any model traffic',async()=>{
 const j=await staged(),spy=vi.spyOn(globalThis,'fetch');expect((await f.call(`/imports/${j.id}/normalize`,{revision:0},{cookie:f.other.cookie})).status).toBe(404);expect((await f.call(`/imports/${j.id}/normalize`,{revision:9})).status).toBe(409);expect(spy).not.toHaveBeenCalled();
 });
 it('uses actual typed Nebius inference, requires currency confirmation and caches one revision',async()=>{
 Object.assign(f.env,{MODELS_DISABLED:'false'});await f.env.CACHE.put('config:models_disabled','0');
 const j=await staged(),spy=model(content());const r=await f.call(`/imports/${j.id}/normalize`,{revision:0});expect(r.status).toBe(200);const out=await r.json() as any;expect(out).toMatchObject({revision:0,ai_ran:true,model:'nvidia/Nemotron-3_5-Lightning',mapping:{cost:'Purchase cost INR',price:'Customer price INR',confirmed_cost_currency:'INR',confirmed_currency:'INR'}});expect(out.questions).toHaveLength(2);expect(spy).toHaveBeenCalledTimes(1);
 expect(await (await f.call(`/imports/${j.id}/normalize`,{revision:0})).json()).toEqual(out);expect(spy).toHaveBeenCalledTimes(1);
 });
 it('does not apply another amount header currency to the selling price',async()=>{
 const j=await staged();const data=content();data.suggestions[1].source_field='price';model(data);const r=await f.call(`/imports/${j.id}/normalize`,{revision:0});expect(r.status).toBe(200);const out=await r.json() as any;expect(out.mapping.confirmed_currency).toBeUndefined();expect(out.questions.some((q:any)=>q.field==='confirmed_currency')).toBe(true);
 });
 it('classifies upstream authentication failure without leaking provider details',async()=>{
 const j=await staged();const spy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({error:{message:'private-auth-detail-never-return',type:'authentication_error'}}),{status:401,headers:{'content-type':'application/json'}}));
 const r=await f.call(`/imports/${j.id}/normalize`,{revision:0});expect(r.status).toBe(503);const text=await r.text();expect(text).toContain('normalization_auth_rejected');expect(text).not.toContain('private-auth-detail');expect(spy).toHaveBeenCalledTimes(1);expect(await(await f.call(`/imports/${j.id}`)).json()).toMatchObject({state:'staged',revision:0});
 });
 it('never applies a fabricated source column: drops it, asks for that field and keeps grounded matches',async()=>{
const j=await staged();model(content('invented purchase cost'));const r=await f.call(`/imports/${j.id}/normalize`,{revision:0});expect(r.status).toBe(200);const text=await r.text();expect(text).not.toContain('invented');const out=JSON.parse(text);expect(out.mapping.cost).toBeUndefined();expect(out.mapping.price).toBe('Customer price INR');expect(out.questions.some((q:any)=>q.field==='cost')).toBe(true);expect(await (await f.call(`/imports/${j.id}`)).json()).toMatchObject({state:'staged'});
 });
 it('fails closed with a specific code when no suggested column exists in the source',async()=>{
const j=await staged();const d=content('invented purchase cost');d.suggestions[1].source_field='invented price';model(d);const r=await f.call(`/imports/${j.id}/normalize`,{revision:0});expect(r.status).toBe(503);const text=await r.text();expect(text).toContain('normalization_ungrounded');expect(text).not.toContain('invented');expect(await (await f.call(`/imports/${j.id}`)).json()).toMatchObject({revision:0,state:'staged'});
 });
});
