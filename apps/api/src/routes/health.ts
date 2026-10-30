import { endpoints } from '@pactovio/contracts';
import type { Register } from '../lib/router';

export const register: Register = (r) => {
  r.on(endpoints.health, async ({ env }) => ({
    ok: true,
    service: 'pactovio-api',
    version: '0.1.0',
    time: new Date().toISOString(),
    bindings: {
      DB: !!env.DB, FILES: !!env.FILES, CACHE: !!env.CACHE, PACK_RUN: !!env.PACK_RUN, SCAN: !!env.SCAN,
      INTAKE: !!env.INTAKE, AGENT: !!env.AGENT, EVENTS: !!env.EVENTS,
      NEBIUS_API_KEY: !!env.NEBIUS_API_KEY, TAVILY_API_KEY: !!env.TAVILY_API_KEY,
    },
  }));
};
