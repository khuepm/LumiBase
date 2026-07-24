import { useState } from 'react';
import { setRuntimeApiBaseUrl } from '@/lib/api-base';

/**
 * First-run gate shown only inside the desktop/mobile shell, where the bundled
 * SPA has no co-located backend and must be pointed at a LumiBase CMS server.
 *
 * The entered origin is validated against the CMS `/health` endpoint (public,
 * no auth) and, on success, persisted as the runtime API-base override. We then
 * reload so every module re-initializes against the chosen server.
 */

const PROBE_TIMEOUT_MS = 5000;

type Status = 'idle' | 'checking' | 'error';

function normalize(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Default to https:// when the user omits a scheme.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

async function probe(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    // Any response that isn't a server error means the CMS is reachable.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function ServerConnection({ onConnected }: { onConnected?: () => void }) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const origin = normalize(value);
    if (!origin) {
      setStatus('error');
      setMessage('Enter your LumiBase server URL.');
      return;
    }

    setStatus('checking');
    setMessage('');

    const reachable = await probe(origin);
    if (!reachable) {
      setStatus('error');
      setMessage(`Could not reach ${origin}. Check the URL and that the server is running.`);
      return;
    }

    setRuntimeApiBaseUrl(origin);
    if (onConnected) {
      onConnected();
    } else {
      window.location.reload();
    }
  }

  const checking = status === 'checking';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-8 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Connect to LumiBase</h1>
          <p className="text-sm text-muted-foreground">
            Enter the address of your LumiBase server to get started.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="server-url" className="text-sm font-medium">
            Server URL
          </label>
          <input
            id="server-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoFocus
            placeholder="https://cms.example.com"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (status === 'error') setStatus('idle');
            }}
            disabled={checking}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          {status === 'error' && (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={checking}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {checking ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
