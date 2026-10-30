import { NotImplemented, type Tender } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';

export interface TedSearchParams {
  /** TED expert query string, e.g. `buyer-country=IRL AND notice-type=cn-standard`. */
  query: string;
  limit?: number;
  page?: number;
}

export interface EtendersPack {
  resourceId: string;
  files: { filename: string; r2Key: string }[];
}

/** Lane: sources. Search TED; returns tender rows ready to upsert. */
export async function searchTed(_params: TedSearchParams): Promise<Tender[]> {
  throw new NotImplemented('sources.searchTed');
}

/** Lane: sources. Fetch an eTenders (Ireland) pack by resource id; stores files in R2. */
export async function fetchEtendersPack(_resourceId: string): Promise<EtendersPack> {
  throw new NotImplemented('sources.fetchEtendersPack');
}

/** Lane: sources. Nightly scan: pull new notices, triage with MODEL_FAST, write tenders + tender_matches, emit tender.matched. */
export async function runNightlyScan(_env: Env): Promise<{ scanned: number; matched: number }> {
  throw new NotImplemented('sources.runNightlyScan');
}
