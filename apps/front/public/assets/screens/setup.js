// #/setup: returning customers finish onboarding v2 inside the app without being gated.
import { h } from '../ui.js';
import { renderSetup } from '../onboarding.js';

export async function render(root, _params, ctx) {
  ctx.setCrumbs('Setup');
  const host = h('div');
  root.append(host);
  const dispose = await renderSetup(host, ctx.session, async () => {
    await ctx.refreshSetup?.();
    location.hash = '#/today';
  });
  return () => dispose?.();
}
