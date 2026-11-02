import { describe, expect, it } from 'vitest';
import { extractDeadlines } from '../src/lib/deadline-extract';
import { otpEmail } from '../src/lib/otp-email';
import { mergeCited } from '../src/lib/site-analyze';
import { candidatePages, deterministicDraft, extractPage } from '../src/lib/site-extract';

describe('deadline extraction', () => {
  const rfq = `Request for Quotation RFQ-2026-118: Laboratory calibration services.
Clarification questions must be submitted by 12 March 2026.
The site visit will take place on March 18, 2026 at the Penang plant.
Tenders must be received no later than 2026-04-02 12:00 MYT.
Contract start is expected on 01/05/2026. Delivery within 30 days. Invalid: 31/02/2026 and 2026-13-01.`;
  it('reads all four formats day-first with the surrounding sentence as excerpt', () => {
    const items = extractDeadlines(rfq);
    expect(items.map((i) => i.due_at)).toEqual(['2026-03-12', '2026-03-18', '2026-04-02', '2026-05-01']);
    expect(items[0]).toMatchObject({ excerpt: 'Clarification questions must be submitted by 12 March 2026.', confidence: 'explicit' });
    expect(items[0]!.title).toMatch(/^Clarification questions must be submitted/);
    expect(items[2]!.excerpt).toContain('Tenders must be received');
    expect(items.every((i) => rfq.replace(/\s+/g, ' ').includes(i.excerpt))).toBe(true);
  });
  it('returns nothing for text without dates and never invents a time', () => {
    expect(extractDeadlines('Please quote 40 units of the ML-100 laser level.')).toEqual([]);
  });
});

describe('website extraction', () => {
  const home = new URL('https://www.meridian-instruments.com/');
  const sameSite = (u: URL) => u.hostname.endsWith('meridian-instruments.com');
  const page = extractPage(`<!doctype html><html><head><title>Home | Meridian Instruments</title>
    <meta name="description" content="Calibration &amp; test equipment for process plants.">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Meridian Instruments Sdn Bhd","address":{"addressCountry":"MY"}}</script>
    <script>var ignored = '<a href="/products/hidden">Hidden</a>';</script></head><body>
    <nav><a href="/products">Products</a><a href="/products/pressure-calibrators">Pressure calibrators</a><a href="/products/laser-levels">Laser levels</a>
    <a href="/industries/water">Water utilities</a><a href="/about">About us</a><a href="https://other.example/products/x">Partner</a>
    <a href="mailto:sales@meridian-instruments.com">Email</a><a href="/files/catalogue.pdf">Catalogue</a></nav>
    <h1>Industrial calibration equipment and instruments</h1><p>We manufacture sensors and calibration instruments for industrial automation.</p></body></html>`, home, sameSite);
  it('extracts only facts present in the page and same-site links', () => {
    expect(page).toMatchObject({ title: 'Home | Meridian Instruments', description: 'Calibration & test equipment for process plants.', orgName: 'Meridian Instruments Sdn Bhd', country: 'MY' });
    expect(page.links.map((l) => l.text)).not.toContain('Hidden');
    expect(page.links.some((l) => l.url.includes('other.example') || l.url.includes('.pdf') || l.url.startsWith('mailto'))).toBe(false);
    expect(candidatePages(page)).toEqual(['https://www.meridian-instruments.com/products', 'https://www.meridian-instruments.com/industries/water',
      'https://www.meridian-instruments.com/about', 'https://www.meridian-instruments.com/products/pressure-calibrators']);
    const draft = deterministicDraft([page]);
    expect(draft).toMatchObject({ name: 'Meridian Instruments Sdn Bhd', country: 'MY', supplier_segment: 'industrial', customers: [],
      offerings: ['Pressure calibrators', 'Laser levels'], markets: ['Water utilities'] });
  });
  it('keeps model items only when they cite a fetched page', () => {
    const det = deterministicDraft([page]);
    const merged = mergeCited(det, {
      name: 'Meridian', description: { text: 'Invented summary', source_url: 'https://elsewhere.example/' },
      offerings: [{ text: 'Temperature calibrators', source_url: page.url }, { text: 'Drones', source_url: 'https://elsewhere.example/' }],
      customers: [{ text: 'Air Selangor', source_url: page.url }, { text: 'Unnamed bank', source_url: 'https://www.meridian-instruments.com/blog' }],
      markets: [], capabilities: [], country: { code: 'SG', source_url: page.url }, supplier_segment: null,
    }, new Set([page.url]));
    expect(merged.offerings).toEqual(['Temperature calibrators', 'Pressure calibrators', 'Laser levels']);
    expect(merged.customers).toEqual(['Air Selangor']);
    expect(merged.description).toBe('Calibration & test equipment for process plants.');
    expect(merged.country).toBe('MY');
  });
});

describe('OTP email', () => {
  it('renders an escaped, image-free HTML part with a plain-text twin', () => {
    const mail = otpEmail('048213', { email: 'buyer+<script>@meridian.example' });
    expect(mail.subject).toBe('Your Pactovio sign-in code');
    expect(mail.text).toContain('048213');
    expect(mail.text).toContain('10 minutes');
    expect(mail.html).toContain('048 213');
    expect(mail.html).toContain('#f2600c');
    expect(mail.html).toContain('pactovio.pages.dev');
    expect(mail.html).toMatch(/didn't request this code/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('buyer+&lt;script&gt;@meridian.example');
    expect(mail.html).not.toMatch(/<img\b/i);
    expect(() => otpEmail('12345')).toThrow();
    expect(() => otpEmail('<b>1</b>')).toThrow();
  });
});
