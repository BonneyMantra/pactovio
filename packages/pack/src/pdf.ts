import { extractText, getDocumentProxy } from 'unpdf';

export interface PdfResult {
  pages: { n: number; text: string }[];
  /** 1-based pages with (almost) no text layer: scans, drawings, diagrams for the vision model. */
  imagePages: number[];
}

const IMAGE_PAGE_MAX_CHARS = 40;

export async function extractPdf(bytes: Uint8Array): Promise<PdfResult> {
  const pdf = await getDocumentProxy(bytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((t, i) => ({ n: i + 1, text: t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() }));
  return { pages, imagePages: pages.filter((p) => p.text.length < IMAGE_PAGE_MAX_CHARS).map((p) => p.n) };
}
