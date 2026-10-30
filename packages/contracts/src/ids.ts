/** Prefixed ULIDs: `tnd_01J...`. Pure, works in Workers, Node and browsers. */
export const ID_PREFIXES = {
  workspace: 'ws',
  session: 'ses',
  tender: 'tnd',
  document: 'doc',
  intake: 'int',
  run: 'run',
  step: 'stp',
  requirement: 'req',
  verdict: 'vrd',
  evidence: 'evd',
  chunk: 'chk',
  answer: 'ans',
  audit: 'aud',
  product: 'prd',
  priceRule: 'prl',
  designRequest: 'dsg',
  quote: 'quo',
  connector: 'cnx',
  webhook: 'whk',
  delivery: 'dlv',
  apiKey: 'key',
  event: 'evt',
  ledger: 'led',
  thread: 'thr',
  message: 'msg',
  action: 'act',
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return time + rand;
}

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid().toLowerCase()}`;
}
