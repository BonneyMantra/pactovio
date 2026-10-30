import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/retrieve';
import { enforceWordLimit } from '../src/draft';
import { wordCount } from '../src/util';
import { docxToPages } from '../src/docx-text';

describe('helpers', () => {
  it('chunkText splits on sentence boundaries and keeps short text whole', () => {
    expect(chunkText('One short sentence.')).toEqual(['One short sentence.']);
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} has exactly seven words here.`).join(' ');
    const chunks = chunkText(long, 60);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => wordCount(c) <= 70)).toBe(true);
    expect(chunks.join(' ')).toBe(long);
  });
  it('enforceWordLimit cuts at a sentence boundary and never exceeds the limit', () => {
    const t = 'First point is here. Second point is here too. Third point follows afterwards.';
    const out = enforceWordLimit(t, 9);
    expect(out).toBe('First point is here. Second point is here too.');
    expect(wordCount(enforceWordLimit(t, 4))).toBeLessThanOrEqual(4);
    expect(enforceWordLimit(t, 100)).toBe(t);
  });
  it('docxToPages joins table rows on one line and splits on page breaks', () => {
    const xml = `<w:body><w:p><w:r><w:t>Intro</w:t></w:r></w:p><w:p><w:r><w:lastRenderedPageBreak/><w:t>Page two</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Text &amp; more</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>`;
    expect(docxToPages(xml)).toEqual(['Intro', 'Page two\nA1 | Text & more']);
  });
});
