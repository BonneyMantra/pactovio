import { Hono } from 'hono';
import { dodoWebhook } from './inbound-dodo';
import { notImplemented } from '../lib/router';
import type { AppEnv } from '../lib/types';

/** Third-party callbacks at the root (not under /api or /v1). Signature checks belong to the owning lane. */
export const inboundWebhooks = new Hono<AppEnv>()
  .post('/webhooks/composio', (c) => notImplemented(c, 'Composio webhook'))
  .route('/', dodoWebhook);
