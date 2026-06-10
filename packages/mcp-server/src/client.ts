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

export class LumiBaseClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: LumiBaseConfig) {
    this.baseUrl = config.url.replace(/\/$/, '') + '/api/v1';
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

  delete(path: string) {
    return this.request<void>('DELETE', path);
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
