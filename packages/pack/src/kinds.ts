import type { DocKind } from '@pactovio/contracts';

export type PackKind = (typeof DocKind)['options'][number];

const BY_EXT: Record<string, PackKind> = {
  pdf: 'pdf', docx: 'docx', doc: 'docx', docm: 'docx', xlsx: 'xlsx', xls: 'xlsx', xlsm: 'xlsx',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', tif: 'image', tiff: 'image',
  zip: 'zip',
};

export const extOf = (filename: string): string => (filename.split('.').pop() ?? '').toLowerCase();
export const baseName = (path: string): string => path.split('/').pop() ?? path;

/** Document kind from the file extension; null for files we do not read (xml, txt, exe...). */
export function kindOf(filename: string): PackKind | null {
  return BY_EXT[extOf(filename)] ?? null;
}

/** Binary Office formats (.doc/.xls) we cannot parse in a Worker. */
export const isLegacyOffice = (filename: string): boolean => ['doc', 'xls'].includes(extOf(filename));

export const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  zip: 'application/zip',
};
