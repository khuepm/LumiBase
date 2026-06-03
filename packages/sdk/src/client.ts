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
}

export interface LumiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface LumiErrorBody {
  errors: Array<{
    code: string;
    message: string;
    path?: string[];
    trace?: unknown;
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

  async function rawRequest<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<LumiResponse<T>> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(opts.headers ?? {})) {
      headers.set(key, value);
    }
    headers.set("authorization", `Bearer ${opts.token}`);
    headers.set("x-lumi-site", opts.siteId);
    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }

    const res = await fetcher(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    const body = parseResponseBody(text);

    if (!res.ok) throw new LumiError(res.status, toErrorBody(res.status, body));
    return body as LumiResponse<T>;
  }

  const baseClient = {
    url: opts.url,
    token: opts.token,
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
