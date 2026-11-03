/** Thrown by cross-lane stubs until the owning lane fills them in. The API maps it to 501 { error, code: 'not_implemented' }. */
export class NotImplemented extends Error {
  readonly code = 'not_implemented';
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplemented';
  }
}

export class HttpError extends Error {
  /** `details` are extra safe, client-facing fields merged into the `{ error, code }` body (e.g. `missing`). */
  constructor(public status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 501 | 502 | 503, message: string, public code?: string,
    public details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
  }
}
