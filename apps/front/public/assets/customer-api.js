// Customer API contract stays here; there is deliberately no demo-session fallback.
import { api } from './ui.js';

export async function session() {
  const value = await api('/session');
  if (value?.authenticated !== true || !value.user?.id || !value.workspace_id || !value.workspace || [1, true].includes(value.workspace.sample)) {
    throw new Error('We could not verify your private workspace. Please try again.');
  }
  return value;
}
export const requestCode = (email) => api('/auth/code/request', { method: 'POST', body: { email } });
export const verifyCode = (email, code) => api('/auth/code/verify', { method: 'POST', body: { email, code } });
export const logout = () => api('/auth/logout', { method: 'POST', body: {} });
export const getCompany = () => api('/onboarding');
export const saveCompany = (company) => api('/onboarding', { method: 'PATCH', body: { company } });
export const completeCompany = () => api('/onboarding/complete', { method: 'POST', body: {} });

export function friendlyError(error) {
  if (error.code === 'needs_setup' || error.code === 'connector_not_configured') return 'This provider is not configured for connections yet. You can continue without it and try again later.';
  if (error.status === 429) return 'Too many attempts. Please wait before trying again. Your details are still here.';
  if (error.code === 'invalid_code') return 'That code is incorrect or has expired. Check the latest email, or request a new code.';
  if (error.code === 'auth_unavailable' || error.code === 'delivery_unavailable') return 'We could not send your code. Please try again in a little while.';
  if (error.status === 401) return 'Your session has expired. Sign in again to continue.';
  if (!error.status || error.status >= 500) return 'We could not reach Pactovio. Check your connection and try again.';
  return error.message || 'Something went wrong. Please try again.';
}

export function connectorDestination(value) {
  if (typeof value !== 'string' || !(/^https:\/\//i.test(value) || /^\/app(?:#|$)/.test(value))) throw new Error('Connection unavailable');
  return value;
}
