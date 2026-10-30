import { NotImplemented, type ExtractPackInput, type PackText } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

/**
 * Lane: pack. Download R2 objects (zip/pdf/docx/xlsx/images), extract text per page, detect forms,
 * store text to R2 (`documents.text_r2_key`) and return the whole pack as text.
 */
export async function extractPack(_env: Env, _input: ExtractPackInput): Promise<PackText> {
  throw new NotImplemented('pack.extractPack');
}
