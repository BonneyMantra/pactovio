// Only a navigation hash is retained across OAuth; no customer form values or tokens.
const PREFIX = 'pv:setup-return:';
const safe = (hash) => typeof hash === 'string' && hash.length < 500 && /^#\/(today|inbox|tenders|quotes|agent|connections|evidence|catalogue|company|settings|how|pricing|help)(\/[^?#]*)?$/.test(hash);
export function rememberSetupReturn(workspace) {
  const hash = location.hash.split('?')[0];
  if (!safe(hash)) return;
  try { sessionStorage.setItem(PREFIX + workspace, hash); } catch { /* storage is optional */ }
}
export function restoreSetupReturn(workspace) {
  let hash;
  try { hash = sessionStorage.getItem(PREFIX + workspace); sessionStorage.removeItem(PREFIX + workspace); } catch { /* storage is optional */ }
  if (/^#\/(onboarding|setup-connections)(\?|$)/.test(location.hash)) history.replaceState(null, '', `/app${safe(hash) ? hash : '#/today'}`);
}
export function clearSetupReturn() {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key); } catch { /* storage is optional */ }
}
