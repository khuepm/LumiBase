/**
 * Figma REST client (#758): just enough to read one frame. The personal
 * access token is the site's tool secret `FIGMA_TOKEN`; `fetch` is injected
 * so tests replay fixture JSON and Workers / Node share the code.
 *
 * Docs: `GET https://api.figma.com/v1/files/:key/nodes?ids=:id` with the
 * `X-Figma-Token` header.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface FigmaPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  imageRef?: string;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  characters?: string;
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number };
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  cornerRadius?: number;
}

export class FigmaError extends Error {
  constructor(
    readonly code: 'FIGMA_URL_INVALID' | 'FIGMA_TOKEN_REJECTED' | 'FIGMA_NOT_FOUND' | 'FIGMA_RATE_LIMITED' | 'FIGMA_UNAVAILABLE' | 'FIGMA_NOT_A_FRAME',
    message: string,
    readonly status: 400 | 404 | 422 | 429 | 502,
  ) {
    super(message);
    this.name = 'FigmaError';
  }
}

/**
 * Parse a Figma link (`/design/`, `/file/` or `/proto/`) into the file key and
 * node id. The URL form of a node id uses `-` (`12-34`); the API wants `:`.
 */
export function parseFigmaUrl(raw: string): { fileKey: string; nodeId: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FigmaError('FIGMA_URL_INVALID', 'Not a URL.', 400);
  }
  if (!/^(www\.)?figma\.com$/.test(url.hostname)) {
    throw new FigmaError('FIGMA_URL_INVALID', 'Use a link from figma.com.', 400);
  }
  const m = /^\/(?:design|file|proto)\/([A-Za-z0-9]{10,128})(?:\/|$)/.exec(url.pathname);
  if (!m) throw new FigmaError('FIGMA_URL_INVALID', 'The link does not name a Figma file.', 400);
  const node = url.searchParams.get('node-id');
  if (!node || !/^\d+[-:]\d+$/.test(node)) {
    throw new FigmaError('FIGMA_URL_INVALID', 'Copy the link of a frame ("Copy link to selection"): it needs a node-id.', 400);
  }
  return { fileKey: m[1]!, nodeId: node.replace('-', ':') };
}

export class FigmaClient {
  private readonly fetch: FetchLike;
  private readonly base: string;

  constructor(private readonly opts: { token: string; fetch?: FetchLike; apiBase?: string }) {
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.base = (opts.apiBase ?? 'https://api.figma.com').replace(/\/$/, '');
  }

  /** The frame (or component) `nodeId` of `fileKey`, with its subtree. */
  async getNode(fileKey: string, nodeId: string): Promise<FigmaNode> {
    const url = `${this.base}/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
    let res: Response;
    try {
      res = await this.fetch(url, { headers: { 'X-Figma-Token': this.opts.token, Accept: 'application/json' } });
    } catch (err) {
      throw new FigmaError('FIGMA_UNAVAILABLE', `Figma could not be reached: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    if (res.status === 401 || res.status === 403) {
      throw new FigmaError('FIGMA_TOKEN_REJECTED', 'Figma rejected the token, or it cannot read this file.', 422);
    }
    if (res.status === 404) throw new FigmaError('FIGMA_NOT_FOUND', 'Figma file not found.', 404);
    if (res.status === 429) throw new FigmaError('FIGMA_RATE_LIMITED', 'Figma rate limit reached; try again shortly.', 429);
    if (!res.ok) throw new FigmaError('FIGMA_UNAVAILABLE', `Figma answered HTTP ${res.status}.`, 502);
    const body = (await res.json()) as { nodes?: Record<string, { document?: FigmaNode } | null> };
    const doc = body.nodes?.[nodeId]?.document;
    if (!doc) throw new FigmaError('FIGMA_NOT_FOUND', 'That node is not in the file.', 404);
    if (!['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION'].includes(doc.type)) {
      throw new FigmaError('FIGMA_NOT_A_FRAME', `Select a frame or component, not a ${doc.type.toLowerCase()}.`, 422);
    }
    return doc;
  }
}
