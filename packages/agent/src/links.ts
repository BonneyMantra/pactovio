const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}

export type Decision = 'confirm' | 'decline';

/** Signed approve/decline link token for Slack/Teams: HMAC(secret, workspace.action.decision), 32 hex chars. */
export async function signDecision(secret: string, workspaceId: string, actionId: string, decision: Decision): Promise<string> {
  return (await hmac(secret, `agent-action.${workspaceId}.${actionId}.${decision}`)).slice(0, 32);
}

export async function verifyDecision(secret: string, workspaceId: string, actionId: string, decision: Decision, token: string): Promise<boolean> {
  const want = await signDecision(secret, workspaceId, actionId, decision);
  if (token.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
