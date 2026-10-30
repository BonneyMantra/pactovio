import { HOUSING, MALTA, MAYNOOTH, METEIREANN, TEAGASC } from './seed-lib';

/**
 * Real showcase packs (public tender documents) in fixtures/packs/<slug>/ (gitignored; sources in fixtures/packs/SOURCES.md).
 * `resourceId` is the eTenders CfT id used by listContractDocuments.do (not the TED publication number in the sample row).
 * `files` limits the upload to the documents as downloaded (the Teagasc folder also holds loose copies of the zip content).
 */
export interface PackSpec {
  slug: string;
  tenderId: string;
  resourceId: string;
  host: string;
  files?: string[];
}

export const IE = 'www.etenders.gov.ie';
export const MT = 'www.etenders.gov.mt';

export const PACKS: PackSpec[] = [
  {
    slug: 'ie-teagasc-695163', tenderId: TEAGASC, resourceId: '9239900', host: IE,
    files: ['P4941_9239900_Web_apps_tender_documents_V2.zip', 'P4941 Clarifications 21102026A.pdf', 'NMP Architecture diagram P4941 LOT2.png'],
  },
  { slug: 'ie-meteireann-701573', tenderId: METEIREANN, resourceId: '9253519', host: IE },
  { slug: 'ie-housing-720768', tenderId: HOUSING, resourceId: '9304329', host: IE },
  { slug: 'mt-spd-714097', tenderId: MALTA, resourceId: '14183960', host: MT },
  { slug: 'ie-maynooth-728304', tenderId: MAYNOOTH, resourceId: '9322692', host: IE },
];
