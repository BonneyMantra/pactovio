import { ActionError, need, type ActionCtx, type Input, type ProviderActions } from '../actions';
import { bytesToB64, deepFind, deepFindArray, mimeFor, ymd } from '../util';

interface Line { description: string; qty: number; unit_price_minor: number }
const lines = (i: Input): Line[] => {
  const l = (Array.isArray(i.lines) ? i.lines : []) as Line[];
  if (!l.length) throw new ActionError('lines is required', 'bad_input');
  return l;
};
const major = (minor: number) => Math.round(minor) / 100;
const q = (s: string) => s.replace(/'/g, "\\'");

const SAMPLE = () => ({
  customer: { name: 'Pactovio Test Customer Ltd', email: null as string | null },
  currency: 'EUR', reference: 'PACTOVIO-TEST', valid_until: ymd(new Date(Date.now() + 30 * 86_400_000)),
  lines: [{ description: 'RS-485 visibility sensor, Modbus RTU', qty: 2, unit_price_minor: 184_000 }, { description: 'Installation and commissioning', qty: 1, unit_price_minor: 45_000 }],
});

// ---- QuickBooks ----

async function qbCustomer(ctx: ActionCtx, c: { name: string; email?: string | null }): Promise<string> {
  const found = deepFind((deepFindArray(await ctx.exec('QUICKBOOKS_QUERY_CUSTOMERS', { query: `select * from Customer where DisplayName = '${q(c.name)}'` }), ['Customer']) ?? [])[0], ['Id']);
  if (found) return found;
  const created = await ctx.exec('QUICKBOOKS_CREATE_CUSTOMER', { display_name: c.name, CompanyName: c.name.slice(0, 100), ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}) });
  return need(deepFind(created, ['Id']), 'QuickBooks customer id');
}

async function qbItem(ctx: ActionCtx): Promise<string> {
  const saved = ctx.meta.config?.item_id as string | undefined;
  if (saved) return saved;
  for (const query of ["select * from Item where Type = 'Service' maxresults 1", 'select * from Item maxresults 1']) {
    const id = deepFind((deepFindArray(await ctx.exec('QUICKBOOKS_QUERY_ITEMS', { query }), ['Item']) ?? [])[0], ['Id']);
    if (id) { await ctx.saveConfig({ item_id: id }); return id; }
  }
  throw new ActionError('QuickBooks has no item to put estimate lines on; set config.item_id', 'not_configured');
}

export const quickbooks: ProviderActions = {
  create_estimate: {
    summary: 'Create the customer (if new) and an estimate',
    run: async (i, ctx) => {
      const customer = need(i.customer, 'customer') as { name: string; email?: string | null };
      const customerId = await qbCustomer(ctx, customer);
      const item = await qbItem(ctx);
      const data = await ctx.exec('QUICKBOOKS_CREATE_ESTIMATE', {
        customer_id: customerId,
        lines: lines(i).map((l) => ({
          DetailType: 'SalesItemLineDetail', Amount: major(l.qty * l.unit_price_minor), Description: l.description.slice(0, 4000),
          SalesItemLineDetail: { ItemRef: { value: item }, Qty: l.qty, UnitPrice: major(l.unit_price_minor) },
        })),
        ...(i.reference ? { private_note: `Pactovio ${i.reference}`.slice(0, 4000) } : {}),
        ...(customer.email ? { bill_email: customer.email } : {}),
      });
      return { id: deepFind(data, ['Id']), url: null, details: { customer_id: customerId, sync_token: deepFind(data, ['SyncToken']) } };
    },
    readback: async (out, ctx) => !!out.id && deepFind(await ctx.exec('QUICKBOOKS_GET_ESTIMATE', { estimate_id: out.id }), ['Id']) !== null,
    cleanup: async (out, ctx) => {
      if (!out.id) return;
      const realm = deepFind(await ctx.exec('QUICKBOOKS_GET_COMPANY_INFO', {}), ['Id']);
      if (!realm) return;
      await ctx.proxy({ endpoint: `/v3/company/${realm}/estimate`, method: 'POST', query: { operation: 'delete' }, body: { Id: out.id, SyncToken: out.details?.sync_token ?? '0' } });
    },
    sample: SAMPLE,
  },
};

// ---- Xero ----

async function xeroContact(ctx: ActionCtx, c: { name: string; email?: string | null }): Promise<string> {
  const found = deepFind((deepFindArray(await ctx.exec('XERO_GET_CONTACTS', { searchTerm: c.name, pageSize: 5 }), ['Contacts']) ?? []).find((x) => String((x as { Name?: string }).Name).toLowerCase() === c.name.toLowerCase()), ['ContactID']);
  if (found) return found;
  const created = await ctx.exec('XERO_CREATE_CONTACT', { Name: c.name, IsCustomer: true, ...(c.email ? { EmailAddress: c.email } : {}) });
  return need(deepFind(created, ['ContactID']), 'Xero contact id');
}

export const xero: ProviderActions = {
  create_estimate: {
    summary: 'Create the contact (if new) and a quote',
    run: async (i, ctx) => {
      const customer = need(i.customer, 'customer') as { name: string; email?: string | null };
      const contactId = await xeroContact(ctx, customer);
      const accountCode = ctx.meta.config?.account_code as string | undefined;
      const data = await ctx.exec('XERO_CREATE_QUOTE', {
        ContactID: contactId, Status: 'DRAFT', LineAmountTypes: 'Exclusive', Date: ymd(ctx.now()),
        LineItems: lines(i).map((l) => ({ Description: l.description.slice(0, 4000), Quantity: l.qty, UnitAmount: major(l.unit_price_minor), ...(accountCode ? { AccountCode: accountCode } : {}) })),
        ...(i.valid_until ? { ExpiryDate: String(i.valid_until).slice(0, 10) } : {}),
        ...(i.currency ? { CurrencyCode: i.currency } : {}),
        ...(i.reference ? { Reference: String(i.reference).slice(0, 255), Title: `Quote ${String(i.reference).slice(0, 80)}` } : {}),
      });
      return { id: deepFind(data, ['QuoteID']), url: null, details: { contact_id: contactId, quote_number: deepFind(data, ['QuoteNumber']) } };
    },
    readback: async (out, ctx) => {
      const found = deepFindArray(await ctx.exec('XERO_GET_QUOTES', { ContactID: out.details?.contact_id }), ['Quotes']) ?? [];
      return found.some((x) => (x as { QuoteID?: string }).QuoteID === out.id);
    },
    cleanup: async (out, ctx) => {
      if (out.id) await ctx.exec('XERO_UPDATE_QUOTE', { QuoteID: out.id, Status: 'DELETED', Contact: { ContactID: out.details?.contact_id } });
    },
    sample: SAMPLE,
  },
};

// ---- DocuSign (sandbox) ----

interface DsAccount { accountId: string; baseUri: string; email: string; name: string }

async function dsAccount(ctx: ActionCtx): Promise<DsAccount> {
  const saved = ctx.meta.config?.account as DsAccount | undefined;
  if (saved?.accountId) return saved;
  for (const host of ['https://account-d.docusign.com', 'https://account.docusign.com']) {
    const r = await ctx.proxy({ endpoint: `${host}/oauth/userinfo`, method: 'GET' });
    if (r.status !== 200) continue;
    const accounts = (deepFindArray(r.data, ['accounts']) ?? []) as { account_id: string; base_uri: string; is_default?: boolean }[];
    const acc = accounts.find((a) => a.is_default) ?? accounts[0];
    const email = deepFind(r.data, ['email']);
    if (acc && email) {
      const out = { accountId: acc.account_id, baseUri: acc.base_uri, email: email.toLowerCase(), name: deepFind(r.data, ['name']) ?? email };
      await ctx.saveConfig({ account: out });
      return out;
    }
  }
  throw new ActionError('Could not read the DocuSign account (userinfo)', 'tool_failed');
}

export const docusign: ProviderActions = {
  send_for_signature: {
    summary: 'Send a document for signature to the connected account owner (sandbox)',
    run: async (i, ctx) => {
      const acc = await dsAccount(ctx);
      if (i.signer_email && String(i.signer_email).toLowerCase() !== acc.email) throw new ActionError('DocuSign sandbox sends only to the connected account owner', 'bad_input');
      const doc = ctx.file ?? { filename: String(i.filename ?? 'quote.txt'), mimetype: 'text/plain', bytes: new TextEncoder().encode(`${String(need(i.text, 'text'))}\n\nSigned for acceptance: /sig/\n`) };
      const ext = doc.filename.split('.').pop()?.toLowerCase() ?? 'txt';
      if (!doc.mimetype.includes('/') || mimeFor(doc.filename) === 'application/octet-stream') throw new ActionError(`Unsupported document type .${ext}`, 'bad_input');
      const r = await ctx.proxy({
        endpoint: `${acc.baseUri}/restapi/v2.1/accounts/${acc.accountId}/envelopes`, method: 'POST',
        body: {
          emailSubject: String(i.subject ?? 'Quote for your signature').slice(0, 100), status: 'sent',
          emailBlurb: 'Sent by Pactovio (sandbox).',
          documents: [{ documentBase64: bytesToB64(doc.bytes), name: doc.filename, fileExtension: ext, documentId: '1' }],
          recipients: { signers: [{ email: acc.email, name: acc.name, recipientId: '1', routingOrder: '1', tabs: { signHereTabs: [{ anchorString: '/sig/', anchorUnits: 'pixels', anchorIgnoreIfNotPresent: 'true', documentId: '1' }] } }] },
        },
      });
      const id = deepFind(r.data, ['envelopeId']);
      if (r.status >= 300 || !id) throw new ActionError(`DocuSign refused the envelope (${r.status}): ${deepFind(r.data, ['message', 'errorCode']) ?? 'no envelope id'}`);
      return { id, url: null, details: { to: acc.email, status: deepFind(r.data, ['status']) } };
    },
    readback: async (out, ctx) => {
      const acc = await dsAccount(ctx);
      return !!out.id && deepFind(await ctx.exec('DOCUSIGN_GET_ENVELOPE', { account_id: acc.accountId, envelope_id: out.id }), ['envelopeId', 'status']) !== null;
    },
    cleanup: async (out, ctx) => {
      if (!out.id) return;
      const acc = await dsAccount(ctx);
      await ctx.proxy({ endpoint: `${acc.baseUri}/restapi/v2.1/accounts/${acc.accountId}/envelopes/${out.id}`, method: 'PUT', body: { status: 'voided', voidedReason: 'Pactovio connector test' } });
    },
    sample: () => ({ subject: 'Pactovio connector test quote', filename: 'pactovio-test-quote.txt', text: 'Quote PACTOVIO-TEST\n2 x RS-485 visibility sensor ... EUR 3,680.00\nThis is a sandbox test document.' }),
  },
};
