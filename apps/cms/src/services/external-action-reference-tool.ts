import type {
  ExternalActionBlastRadius,
  ExternalActionReversibility,
  ExternalActionRisk,
  ExternalActionToolDefinition,
} from './external-action-tools';

/**
 * Reference external-action tool: an HTTP echo.
 *
 * It exists to show the shape of a tool and to give the test suite something
 * harmless to govern. It is NOT registered anywhere: nothing in LumiBase adds
 * it to the registry, and it talks only to the endpoint and `fetch` it is
 * constructed with (the tests pass an in-memory stub).
 *
 * What it demonstrates:
 * - the declaration (`risk`, `reversibility`, `blastRadius`, `capability`,
 *   `secrets`) that the harness decides on;
 * - a secret used by reference: the handler asks the context for
 *   `HTTP_ECHO_TOKEN` and sends it as a bearer token. The arguments never
 *   carry it and the handler never returns it.
 */

export const HTTP_ECHO_SECRET = 'HTTP_ECHO_TOKEN';

export interface HttpEchoToolOptions {
  /** Where the message is posted. */
  endpoint: string;
  /** Injected so the tool never reaches a network the caller did not hand it. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
  name?: string;
  capability?: string;
  risk?: ExternalActionRisk;
  reversibility?: ExternalActionReversibility;
  blastRadius?: ExternalActionBlastRadius;
}

export function createHttpEchoTool(options: HttpEchoToolOptions): ExternalActionToolDefinition {
  const reversibility = options.reversibility ?? 'reversible';
  return {
    name: options.name ?? 'httpEcho',
    description: 'Posts a message to a configured echo endpoint and returns the response body.',
    capability: options.capability ?? 'echo:send',
    risk: options.risk ?? 'low',
    reversibility,
    blastRadius: options.blastRadius ?? (reversibility === 'read_only' ? { scope: 'none' } : { scope: 'single' }),
    secrets: [HTTP_ECHO_SECRET],
    owner: 'reference',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', maxLength: 2000, description: 'Text to echo.' },
      },
      required: ['message'],
    },
    handler: async (args, context) => {
      const response = await options.fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${context.secret(HTTP_ECHO_SECRET)}`,
        },
        body: JSON.stringify({ message: args['message'] }),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`echo endpoint answered ${response.status}: ${body.slice(0, 500)}`);
      }
      return { status: response.status, echoed: body };
    },
  };
}
