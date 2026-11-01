import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { quoteDocx, type QuoteDoc } from '../src/export';

const doc: QuoteDoc = {
  seller: 'Seabridge Instruments', customer: 'Harbourview Port', subject: 'Outdoor monitoring sensors',
  tax_label: 'Tax', tax_bp: 0,
  quote: { id: 'quote_customer', workspace_id: 'ws_customer', design_request_id: null, tender_id: null,
    currency: 'EUR', lines: [], subtotal_minor: 0, discount_minor: 0, tax_minor: 0,
    total_minor: 0, valid_until: null, status: 'ready' },
};
const xml = (d: QuoteDoc) => strFromU8(unzipSync(quoteDocx(d))['word/document.xml']!);

describe('customer quote exports', () => {
  it('does not describe a real company as fictional or invent delivery commitments', () => {
    const content = xml(doc);
    expect(content).toContain('Seabridge Instruments');
    expect(content).not.toContain('fictional');
    expect(content).not.toContain('8 to 12 weeks');
    expect(content).toContain('require supplier confirmation');
  });
  it('keeps the sample label only for an explicitly sample workspace', () => {
    expect(xml({ ...doc, sample: true })).toContain('Sample company (fictional)');
  });
});
