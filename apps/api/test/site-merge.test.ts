import { describe, expect, it } from 'vitest';
import { mergeCited } from '../src/lib/site-analyze';

const page = 'https://www.rax-tech.com/products';
const cite = (text: string) => ({ text, source_url: page });

describe('mergeCited offerings', () => {
  it('keeps product names and drops slogans, the description, duplicates and uncited items', () => {
    const description = 'RAX Tech designs and manufactures electronics for IoT and automation.';
    const ai = {
      description: cite(description), offerings: [cite(description), cite('49 products across six domains, built for reliability.'),
        cite('PLC Panels'), cite('PLC panels'), cite('Rack Monitoring Controller'), { text: 'Invented thing', source_url: 'https://elsewhere.example' }],
      customers: [], markets: [], capabilities: [], country: null, supplier_segment: null, name: null,
    };
    const out = mergeCited({ offerings: ['Embedded Systems Design', 'Embedded systems design'], customers: [], markets: [], capabilities: [] },
      ai as unknown as Parameters<typeof mergeCited>[1], new Set([page]));
    expect(out.offerings).toEqual(['PLC Panels', 'Rack Monitoring Controller', 'Embedded Systems Design']);
  });
});
