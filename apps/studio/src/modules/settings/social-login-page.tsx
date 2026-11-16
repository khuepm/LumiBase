import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Check, Copy, KeyRound, Loader2 } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Settings → Social login (#736). Per-site Google / Apple / GitHub sign-in for
 * the site's public members (subscriber realm). Reads
 * `GET /api/v1/admin/social-providers`, saves with `PUT /:provider`, removes
 * with `DELETE /:provider`.
 *
 * Secrets (client secret, Apple `.p8` key) are write-only: the API reports
 * whether one is stored but never returns it, so the inputs start empty and a
 * blank field on save keeps the stored value.
 *
 * Same bearer + `getApiBaseUrl()` plumbing as the Security page so it works
 * cross-origin and in the desktop shell (contract C2).
 */

export type SocialProviderKey = 'google' | 'apple' | 'github';

export interface ProviderConfigRow {
  provider: SocialProviderKey;
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  appleTeamId: string | null;
  appleKeyId: string | null;
  hasApplePrivateKey: boolean;
  allowedRedirectUris: string[];
  callbackUri: string;
  updatedAt: string | null;
}

export const SOCIAL_PROVIDERS_QUERY_KEY = ['admin-social-providers'] as const;

const LABELS: Record<SocialProviderKey, string> = { google: 'Google', apple: 'Apple', github: 'GitHub' };

const CONSOLE_HINT: Record<SocialProviderKey, string> = {
  google: 'Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application).',
  apple: 'Apple Developer → Identifiers → Services IDs (Sign in with Apple), plus a Sign in with Apple key (.p8).',
  github: 'GitHub → Settings → Developer settings → OAuth Apps.',
};

const headers = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Lumi-Site': getActiveSite(),
  'X-Lumi-Client': 'studio',
  Authorization: `Bearer ${getActiveToken()}`,
});

const url = (path: string) => `${getApiBaseUrl()}${path}`;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null;
  return body?.errors?.[0]?.message ?? fallback;
}

async function fetchProviders(): Promise<ProviderConfigRow[]> {
  const res = await fetch(url('/api/v1/admin/social-providers'), { headers: headers() });
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load social login providers.'));
  return ((await res.json()) as { data: ProviderConfigRow[] }).data;
}

export function parseRedirectUris(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function SocialLoginSettingsPage() {
  const query = useQuery({ queryKey: SOCIAL_PROVIDERS_QUERY_KEY, queryFn: fetchProviders });
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Social login</h1>
        <p className="text-sm text-muted-foreground">
          Let your site&apos;s members sign in with Google, Apple or GitHub. Sessions are always issued in the
          member (subscriber) realm — social login never grants Studio access. A provider account is linked to an
          existing member automatically only when both the provider and the member have verified the same email.
        </p>
      </header>
      {query.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p className="text-destructive">{(query.error as Error).message}</p>
      ) : (
        (query.data ?? []).map((row) => <ProviderCard key={row.provider} row={row} />)
      )}
    </div>
  );
}

function ProviderCard({ row }: { row: ProviderConfigRow }) {
  const qc = useQueryClient();
  const id = useId();
  const [enabled, setEnabled] = useState(row.enabled);
  const [clientId, setClientId] = useState(row.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [teamId, setTeamId] = useState(row.appleTeamId ?? '');
  const [keyId, setKeyId] = useState(row.appleKeyId ?? '');
  const [privateKey, setPrivateKey] = useState('');
  const [redirects, setRedirects] = useState(row.allowedRedirectUris.join('\n'));
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isApple = row.provider === 'apple';
  const label = LABELS[row.provider];

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        enabled,
        clientId: clientId.trim(),
        allowedRedirectUris: parseRedirectUris(redirects),
      };
      if (isApple) {
        body.appleTeamId = teamId.trim();
        body.appleKeyId = keyId.trim();
        if (privateKey.trim()) body.applePrivateKey = privateKey.trim();
      } else if (clientSecret.trim()) {
        body.clientSecret = clientSecret.trim();
      }
      const res = await fetch(url(`/api/v1/admin/social-providers/${row.provider}`), {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Could not save ${label}.`));
    },
    onSuccess: () => {
      setClientSecret('');
      setPrivateKey('');
      setMessage(`${label} saved.`);
      void qc.invalidateQueries({ queryKey: SOCIAL_PROVIDERS_QUERY_KEY });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await fetch(url(`/api/v1/admin/social-providers/${row.provider}`), {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Could not remove ${label}.`));
    },
    onSuccess: () => {
      setMessage(`${label} removed.`);
      void qc.invalidateQueries({ queryKey: SOCIAL_PROVIDERS_QUERY_KEY });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const copyCallback = async () => {
    try {
      await navigator.clipboard.writeText(row.callbackUri);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const secretStored = isApple ? row.hasApplePrivateKey : row.hasClientSecret;
  const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-lg border p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-medium">
          <KeyRound className="h-4 w-4" /> {label}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{CONSOLE_HINT[row.provider]}</p>

      <div className="space-y-1">
        <span className="text-sm font-medium">Callback URL (register this at {label})</span>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded bg-muted px-2 py-1 text-xs" data-testid={`callback-${row.provider}`}>
            {row.callbackUri}
          </code>
          <button type="button" onClick={copyCallback} className="rounded-md border p-1.5" aria-label="Copy callback URL">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <label className="block space-y-1 text-sm">
        <span className="font-medium">{isApple ? 'Services ID (client id)' : 'Client ID'}</span>
        <input className={input} value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </label>

      {isApple ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Team ID</span>
              <input className={input} value={teamId} onChange={(e) => setTeamId(e.target.value)} />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Key ID</span>
              <input className={input} value={keyId} onChange={(e) => setKeyId(e.target.value)} />
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Private key (.p8 contents)</span>
            <textarea
              className={`${input} font-mono`}
              rows={4}
              value={privateKey}
              placeholder={secretStored ? 'Stored — leave blank to keep the current key' : '-----BEGIN PRIVATE KEY-----'}
              onChange={(e) => setPrivateKey(e.target.value)}
            />
          </label>
        </>
      ) : (
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Client secret</span>
          <input
            className={input}
            type="password"
            autoComplete="off"
            value={clientSecret}
            placeholder={secretStored ? 'Stored — leave blank to keep the current secret' : ''}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </label>
      )}

      <label className="block space-y-1 text-sm">
        <span className="font-medium">Allowed redirect URIs (one per line, exact match)</span>
        <textarea
          className={`${input} font-mono`}
          rows={3}
          value={redirects}
          placeholder="https://www.example.com/auth/callback"
          onChange={(e) => setRedirects(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          Where your frontend asks to be sent back after sign-in. Anything not listed is refused.
        </span>
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || !clientId.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save {label}
        </button>
        {row.configured && (
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="rounded-md border px-4 py-2 text-sm"
          >
            Remove
          </button>
        )}
        {message && (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
