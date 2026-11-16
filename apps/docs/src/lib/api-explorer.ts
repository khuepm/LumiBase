/**
 * Pure helpers for the API explorer page (#745).
 *
 * The page points a bundled Swagger UI at a URL the reader types in — there
 * is no default host, and nothing is read from the query string, so a link
 * cannot make the docs site load an attacker-chosen document on its own.
 */

/** Accept only an absolute http(s) URL; everything else is refused. */
export function parseSpecUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export interface ExplorerCredentials {
  site: string;
  token: string;
}

interface InterceptedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Swagger UI request interceptor: attaches `X-Lumi-Site` / `Authorization`
 * only to requests bound for the CMS origin the document came from, so a
 * document that lists a foreign server cannot harvest the reader's token.
 */
export function buildRequestInterceptor(specUrl: URL, credentials: ExplorerCredentials) {
  const origin = specUrl.origin;
  return <T extends InterceptedRequest>(request: T): T => {
    let target: URL;
    try {
      target = new URL(request.url, specUrl);
    } catch {
      return request;
    }
    if (target.origin !== origin) return request;
    const headers = { ...request.headers };
    if (credentials.site.trim()) headers['X-Lumi-Site'] = credentials.site.trim();
    if (credentials.token.trim()) headers['Authorization'] = `Bearer ${credentials.token.trim()}`;
    return { ...request, headers };
  };
}
