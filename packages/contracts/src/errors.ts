/** Thrown by cross-lane stubs until the owning lane fills them in. The API maps it to 501 { error, code: 'not_implemented' }. */
export class NotImplemented extends Error {
  readonly code = 'not_implemented';
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplemented';
  }
}

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 501 | 502, message: string, public code?: string) {
    super(message);
    this.name = 'HttpError';
  }
}
