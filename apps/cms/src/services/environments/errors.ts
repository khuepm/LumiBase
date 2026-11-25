/** Errors of the Content Environments service (#853). `status` is the HTTP status the route answers. */
export class EnvironmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 412 | 422 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}
