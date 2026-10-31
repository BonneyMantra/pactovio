import { budgetMessage, isBudgetError } from '@pactovio/models';
import { Hono, type Context } from 'hono';
import { ZodError, type z } from 'zod';
import { HttpError, NotImplemented, honoPath, type AnyEndpoint } from '@pactovio/contracts';
import type { Env } from '@pactovio/contracts/env';
import { apiKeyAuth, sessionAuth } from './auth';
import type { AppEnv, Auth } from './types';

type Out<S> = [NonNullable<S>] extends [never] ? undefined : NonNullable<S> extends z.ZodType ? z.output<NonNullable<S>> : undefined;

export interface HandlerCtx<E extends AnyEndpoint> {
  c: Context<AppEnv>;
  env: Env;
  db: D1Database;
  auth: Auth;
  workspaceId: string;
  params: Out<E['params']>;
  query: Out<E['query']>;
  body: Out<E['body']>;
}
export type Handler<E extends AnyEndpoint> = (x: HandlerCtx<E>) => Promise<z.output<E['response']> | Response>;

export function errorResponse(c: Context, e: unknown): Response {
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return c.json({ error: msg, code: 'validation' }, 400);
  }
  if (e instanceof HttpError) return c.json({ error: e.message, code: e.code ?? 'error' }, e.status);
  if (isBudgetError(e)) return c.json({ error: budgetMessage(e), code: (e as { code?: string }).code === 'models_off' ? 'models_off' : 'cap_daily' }, 429);
  if (e instanceof NotImplemented) return c.json({ error: e.message, code: 'not_implemented' }, 501);
  console.error('unhandled', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown');
  return c.json({ error: 'Internal error', code: 'internal' }, 500);
}

export const notImplemented = (c: Context, what: string) =>
  c.json({ error: `${what} is not implemented yet`, code: 'not_implemented' }, 501);

/** One Router per prefix (/api session, /v1 API key). Every route module calls `register(r)` on both. */
export class Router {
  readonly app = new Hono<AppEnv>();
  readonly registered = new Set<string>();
  constructor(readonly mode: 'session' | 'apikey') {}

  private wrap(ep: AnyEndpoint, run: (c: Context<AppEnv>, auth: Auth) => Promise<Response>) {
    this.registered.add(ep.id);
    this.app.on(ep.method, honoPath(ep.path), async (c) => {
      try {
        const auth: Auth = ep.public ? { workspaceId: '', sessionId: null, via: 'public' } : this.mode === 'session' ? await sessionAuth(c) : await apiKeyAuth(c);
        return await run(c, auth);
      } catch (e) {
        return errorResponse(c, e);
      }
    });
  }

  on<E extends AnyEndpoint>(ep: E, handler: Handler<E>): void {
    this.wrap(ep, async (c, auth) => {
      const params = ep.params ? ep.params.parse(c.req.param()) : undefined;
      const query = ep.query ? ep.query.parse(c.req.query()) : undefined;
      let body: unknown;
      if (ep.body && ep.kind !== 'multipart') {
        const raw = await c.req.json().catch(() => undefined);
        body = ep.body.parse(raw ?? {});
      }
      const out = await handler({ c, env: c.env, db: c.env.DB, auth, workspaceId: auth.workspaceId, params, query, body } as HandlerCtx<E>);
      if (out instanceof Response) return out;
      if (c.env.ENVIRONMENT === 'development') ep.response.parse(out); // catch contract drift locally
      return c.json(out);
    });
  }

  /** 501 not_implemented. The owning lane replaces `r.stub(...)` with `r.on(...)`. */
  stub(ep: AnyEndpoint, what?: string): void {
    this.wrap(ep, async (c) => notImplemented(c, what ?? `${ep.method} ${ep.path}`));
  }
}

export type Register = (r: Router) => void;
