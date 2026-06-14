import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Shape returned by `GET /api/v1/setup/state`. Mirrors design §4.1.
 *
 * Intentionally minimal: the endpoint must not leak version/hostname info
 * (Req 1.6), so the type narrows to exactly the two flags the gates need.
 */
export interface SetupStateResponse {
  state: 'uninitialized' | 'initialized';
  requiresSetupToken: boolean;
}

/**
 * Error subtype thrown by `fetchSetupState` so React Query callers can
 * distinguish a real network/5xx failure from a malformed response.
 */
export class SetupStateFetchError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SetupStateFetchError';
    this.status = status;
  }
}

export async function fetchSetupState(): Promise<SetupStateResponse> {
  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}/api/v1/setup/state`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new SetupStateFetchError('network');
  }

  if (!res.ok) {
    throw new SetupStateFetchError(`http ${res.status}`, res.status);
  }

  const body = (await res.json()) as Partial<SetupStateResponse>;
  if (body.state !== 'uninitialized' && body.state !== 'initialized') {
    throw new SetupStateFetchError('malformed');
  }

  return {
    state: body.state,
    requiresSetupToken: Boolean(body.requiresSetupToken),
  };
}
