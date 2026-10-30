import { Hono } from 'hono';
import { composioWebhook } from './inbound-composio';
import { dodoWebhook } from './inbound-dodo';
import type { AppEnv } from '../lib/types';

/** Third-party callbacks at the root (not under /api or /v1). Signature checks belong to the owning lane. */
export const inboundWebhooks = new Hono<AppEnv>()
  .route('/', composioWebhook)
  .route('/', dodoWebhook);
