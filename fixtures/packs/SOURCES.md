# Fixture pack sources

Real public tender documents used as fixtures. The files themselves live in `fixtures/packs/<slug>/` (gitignored); only this list is tracked. Resource ids come from the eTenders (Ireland) and eTenders (Malta) portals. The number in each slug is the TED publication number; the real eTenders `resourceId` (used by `listContractDocuments.do`) is in the last column and in `tenders.raw.resource_id`. Seed with `npm run seed:packs -w @pactovio/api` (see apps/api/scripts/seed-packs.ts).

| Slug | Tender | Source | eTenders resourceId |
|---|---|---|---|
| ie-teagasc-695163 | Teagasc P4941 web applications maintenance, support & development (3 lots) | https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=695163 | 9239900 |
| ie-meteireann-701573 | Met Éireann coastal visibility sensors | https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=701573 | 9253519 |
| ie-housing-720768 | Dept of Housing website hosting, development, support and maintenance | https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=720768 | 9304329 |
| mt-spd-714097 | Malta SPD1/2026/032 ICT professional services framework (National Skills Council) | https://www.etenders.gov.mt/epps/cft/prepareViewCfTWS.do?resourceId=714097 | 14183960 |
| ie-maynooth-728304 | Maynooth University RENEW software consultancy (PCO 545) | https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=728304 | 9322692 |
