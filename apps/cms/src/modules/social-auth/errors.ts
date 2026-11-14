/**
 * Typed failure for the social login flow. `code` is the stable machine code a
 * client branches on (returned in `{ errors: [{ code }] }` or as `?error=` on
 * the frontend redirect); `message` is safe to show and never carries a
 * provider response body, token or secret.
 */
export class SocialAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = 'SocialAuthError';
  }
}
