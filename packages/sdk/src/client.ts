/**
 * LumiBase JS SDK
 * Composable Client Architecture
 */

import { DefaultSchema } from "./types";

export interface LumiClientOptions {
  /** Base URL of the API, e.g. `http://127.0.0.1:1989` or `https://api.lumibase.dev`. */
  url: string;
  /** Bearer token (Logto access token, or `dev:<logtoId>` in dev mode). */
  token: string;
  /** Active tenant id. Sent as `X-Lumi-Site`. */
  siteId: string;
  /** Override fetch (Node/Workers polyfills). Defaults to `globalThis.fetch`. */
  fetcher?: typeof fetch;
  /** Additional headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * Invoked once whenever the server answers a request with `401
   * Unauthorized` — i.e. the bearer token is missing, expired, or no
   * longer valid for the resolved site/user. Fires before the `LumiError`
   * is thrown so a host (e.g. Studio) can clear the stale token and route
   * the operator back to the login screen. Errors thrown by the callback
   * are swallowed so they never mask the original `LumiError`.
   *
   * When auto-refresh is enabled (see `refreshToken`), `onUnauthorized`
   * fires only AFTER a refresh attempt has also failed.
   */
  onUnauthorized?: () => void;
  /**
   * Rotating refresh token (body transport). When set, a `401` triggers a
   * single `POST /api/v1/auth/refresh` with this token; on success the new
   * access token is adopted and the original request is retried once. The
   * refresh token rotates each call, so the new pair is surfaced via
   * {@link onTokensRefreshed} for the host to persist. Omit to keep the
   * legacy behaviour (no retry; `onUnauthorized` fires immediately).
   */
  refreshToken?: string;
  /**
   * Called after a successful silent refresh with the rotated token pair so
   * the host can persist them (the old refresh token is now revoked).
   */
  onTokensRefreshed?: (tokens: {
    token: string;
    refreshToken: string;
    refreshTokenExpiresAt?: string;
  }) => void;
}

export interface LumiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface LumiErrorBody {
  errors: Array<{
    code: string;
    message: string;
    path?: string | string[];
    risk?: string;
    trace?: unknown;
    [key: string]: unknown;
  }>;
}

export class LumiError extends Error {
  constructor(
    public status: number,
    public body: LumiErrorBody | any,
  ) {
    super(body?.errors?.[0]?.message ?? `LumiBase ${status}`);
    this.name = "LumiError";
  }
}

function parseResponseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toErrorBody(status: number, body: unknown): LumiErrorBody {
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as { errors?: unknown }).errors)
  ) {
    return body as LumiErrorBody;
  }

  const message =
    typeof body === "string" && body.trim()
      ? body.trim()
      : `LumiBase ${status}`;

  return {
    errors: [
      {
        code: "HTTP_ERROR",
        message,
      },
    ],
  };
}

export interface LumiClient<TSchema extends DefaultSchema = DefaultSchema> {
  url: string;
  token: string;
  siteId: string;
  fetcher: typeof fetch;
  rawRequest: <T>(path: string, init?: RequestInit) => Promise<LumiResponse<T>>;
  request: <Output>(command: (client: LumiClient<TSchema>) => Promise<Output>) => Promise<Output>;
  with: <Extension>(plugin: (client: LumiClient<TSchema>) => Extension) => LumiClient<TSchema> & Extension;
}

export function createLumiClient<TSchema extends DefaultSchema = DefaultSchema>(
  opts: LumiClientOptions,
): LumiClient<TSchema> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const base = opts.url.replace(/\/$/, "");

  // Mutable session state: the access token rotates on silent refresh.
  let currentToken = opts.token;
  let currentRefreshToken = opts.refreshToken;
  // Single-flight guard so a burst of parallel 401s triggers ONE refresh.
  let refreshInFlight: Promise<boolean> | null = null;

  async function attemptRefresh(): Promise<boolean> {
    if (!currentRefreshToken) return false;
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const res = await fetcher(`${base}/api/v1/auth/refresh`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-lumi-site": opts.siteId,
            },
            // Body transport is CSRF-exempt (the token isn't ambient).
            body: JSON.stringify({ refreshToken: currentRefreshToken }),
          });
          if (!res.ok) return false;
          const data = (parseResponseBody(await res.text()) as
            | { data?: { token?: string; refreshToken?: string; refreshTokenExpiresAt?: string } }
            | null)?.data;
          if (!data?.token || !data.refreshToken) return false;
          currentToken = data.token;
          currentRefreshToken = data.refreshToken;
          try {
            opts.onTokensRefreshed?.({
              token: data.token,
              refreshToken: data.refreshToken,
              refreshTokenExpiresAt: data.refreshTokenExpiresAt,
            });
          } catch {
            /* a throwing persist handler must not abort the retry */
          }
          return true;
        } catch {
          return false;
        } finally {
          refreshInFlight = null;
        }
      })();
    }
    return refreshInFlight;
  }

  async function rawRequest<T>(
    path: string,
    init: RequestInit = {},
    retried = false,
  ): Promise<LumiResponse<T>> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(opts.headers ?? {})) {
      headers.set(key, value);
    }
    headers.set("authorization", `Bearer ${currentToken}`);
    headers.set("x-lumi-site", opts.siteId);
    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }

    const res = await fetcher(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const body = parseResponseBody(text);

    if (!res.ok) {
      // Silent refresh + single retry. Skip for the refresh call itself and
      // when no refresh token is configured (legacy behaviour preserved).
      if (
        res.status === 401 &&
        !retried &&
        currentRefreshToken &&
        path !== "/api/v1/auth/refresh"
      ) {
        if (await attemptRefresh()) {
          return rawRequest<T>(path, init, true);
        }
      }
      if (res.status === 401 && opts.onUnauthorized) {
        // Best-effort: a throwing handler must not mask the LumiError.
        try {
          opts.onUnauthorized();
        } catch {
          /* ignore */
        }
      }
      throw new LumiError(res.status, toErrorBody(res.status, body));
    }
    return body as LumiResponse<T>;
  }

  const baseClient = {
    url: opts.url,
    get token() {
      return currentToken;
    },
    siteId: opts.siteId,
    fetcher,
    rawRequest,
    async request<Output>(command: (client: LumiClient<TSchema>) => Promise<Output>): Promise<Output> {
      return command(this as unknown as LumiClient<TSchema>);
    },
    with<Extension>(plugin: (client: LumiClient<TSchema>) => Extension) {
      const ext = plugin(this as unknown as LumiClient<TSchema>);
      return Object.assign(this, ext) as unknown as LumiClient<TSchema> & Extension;
    }
  };

  return baseClient as LumiClient<TSchema>;
}
