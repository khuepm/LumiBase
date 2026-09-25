export interface LumiBaseConfig {
  url: string;
  siteId: string;
  token: string;
}

export interface ApiError {
  code: string;
  message: string;
  path?: string[];
}

export class LumiBaseApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errors: ApiError[],
  ) {
    super(errors[0]?.message ?? `HTTP ${status}`);
    this.name = 'LumiBaseApiError';
  }
}

/**
 * The governed MCP endpoint exists but the site has not enabled it
 * (`contentOs.mcp`, which defaults off). Distinct from a generic failure so the
 * caller can decide between "fall back and say so" and "refuse".
 */
export class McpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnavailableError';
  }
}

export class LumiBaseClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly headers: Record<string, string>;

  constructor(config: LumiBaseConfig) {
    this.origin = config.url.replace(/\/$/, '');
    this.baseUrl = this.origin + '/api/v1';
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
      'X-Lumi-Site': config.siteId,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return undefined as T;

    const json = (await res.json()) as { data?: T; errors?: ApiError[] };

    if (!res.ok) {
      throw new LumiBaseApiError(res.status, json.errors ?? [{ code: 'UNKNOWN', message: `HTTP ${res.status}` }]);
    }

    return json.data as T;
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown) {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, body);
  }

  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }

  delete<T = void>(path: string) {
    return this.request<T>('DELETE', path);
  }

  /**
   * Sends a JSON-RPC request to the governed MCP endpoint (`POST /api/v1/mcp`).
   *
   * Deliberately NOT built on `request()`. That helper returns `json.data`,
   * which is the REST envelope — a JSON-RPC response carries `result` / `error`
   * at the top level and has no `data` key at all, so routing this through
   * `request()` would quietly resolve to `undefined` for every call. The bug
   * would look like "governance returned nothing" rather than "we read the wrong
   * field".
   *
   * @throws {McpUnavailableError} when the site has not enabled `contentOs.mcp`.
   * @throws {LumiBaseApiError} for transport/HTTP failures and JSON-RPC errors.
   */
  async jsonRpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });

    const body = (await res.json().catch(() => null)) as
      | {
          result?: T;
          error?: { code: number; message: string };
          errors?: ApiError[];
        }
      | null;

    if (!res.ok) {
      const errors = body?.errors ?? [{ code: 'UNKNOWN', message: `HTTP ${res.status}` }];
      // The route answers 404 MCP_DISABLED when the per-site flag is off. That
      // is an operator-configuration state, not a failed call, and the caller
      // needs to tell them apart to decide whether falling back is acceptable.
      if (errors.some((e) => e.code === 'MCP_DISABLED')) {
        throw new McpUnavailableError(errors[0]?.message ?? 'MCP endpoint disabled');
      }
      throw new LumiBaseApiError(res.status, errors);
    }

    if (body?.error) {
      throw new LumiBaseApiError(res.status, [
        { code: `JSONRPC_${body.error.code}`, message: body.error.message },
      ]);
    }
    return body?.result as T;
  }

  /**
   * GET a root-level (non-`/api/v1`) endpoint such as `/health` or `/metrics`
   * and return the raw response body as text. These endpoints are not
   * tenant-scoped and do not use the `{data}` envelope.
   */
  getRootText(path: string): Promise<string> {
    return this.textRequest(`${this.origin}${path}`, 'GET');
  }

  /** GET an `/api/v1` endpoint that returns a non-JSON body (e.g. NDJSON backup). */
  getText(path: string): Promise<string> {
    return this.textRequest(`${this.baseUrl}${path}`, 'GET');
  }

  private async textRequest(url: string, method: string): Promise<string> {
    const res = await fetch(url, { method, headers: this.headers });
    const text = await res.text();
    if (!res.ok) {
      throw new LumiBaseApiError(res.status, [
        { code: 'HTTP', message: `HTTP ${res.status}: ${text.slice(0, 200)}` },
      ]);
    }
    return text;
  }

  /**
   * POST a raw (non-JSON) request body to an `/api/v1` endpoint and unwrap the
   * `{data}` envelope from the JSON response (e.g. the NDJSON restore endpoint).
   */
  async postRaw<T>(path: string, body: string, contentType = 'application/x-ndjson'): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': contentType },
      body,
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json()) as { data?: T; errors?: ApiError[] };
    if (!res.ok) {
      throw new LumiBaseApiError(res.status, json.errors ?? [{ code: 'UNKNOWN', message: `HTTP ${res.status}` }]);
    }
    return json.data as T;
  }
}

export function configFromEnv(): LumiBaseConfig {
  const url = process.env['LUMIBASE_URL'];
  const siteId = process.env['LUMIBASE_SITE_ID'];
  const token = process.env['LUMIBASE_TOKEN'];

  if (!url || !siteId || !token) {
    throw new Error(
      'Missing required env vars: LUMIBASE_URL, LUMIBASE_SITE_ID, LUMIBASE_TOKEN',
    );
  }

  return { url, siteId, token };
}
