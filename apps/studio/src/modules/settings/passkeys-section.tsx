import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import { createPasskey, passkeyErrorMessage, passkeysSupported } from '@/lib/passkeys';
import { SESSIONS_QUERY_KEY } from './sessions-section';

/**
 * Passkeys (#735) under Settings → Security: list, add (password step-up, then
 * the browser prompt), rename, remove (password step-up). The first passkey on
 * an account without TOTP returns recovery codes, shown once here.
 *
 * Same bearer + `getApiBaseUrl()` plumbing as the other security sections
 * (contract C2). Inside the desktop shell, or a browser without WebAuthn, the
 * list still renders but adding is replaced by an explanation (contract C5).
 */

export interface PasskeyRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[];
  backedUp: boolean;
  deviceType: string | null;
}

interface PasskeysPayload {
  passkeys: PasskeyRow[];
  recoveryCodesRemaining: number;
  totpEnabled: boolean;
  available: boolean;
}

export const PASSKEYS_QUERY_KEY = ['me-passkeys'] as const;

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

async function fetchPasskeys(): Promise<PasskeysPayload> {
  const res = await fetch(url('/api/v1/me/passkeys'), { headers: headers() });
  if (!res.ok) throw new Error('Failed to load passkeys.');
  return ((await res.json()) as { data: PasskeysPayload }).data;
}

function formatDate(value: string | null): string {
  if (!value) return 'never';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function PasskeysSection() {
  const qc = useQueryClient();
  const passwordId = useId();
  const nameId = useId();
  const supported = passkeysSupported();
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; password: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const query = useQuery({ queryKey: PASSKEYS_QUERY_KEY, queryFn: fetchPasskeys });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: PASSKEYS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ['me-tfa'] });
  };

  const addMutation = useMutation({
    mutationFn: async () => {
      const optionsRes = await fetch(url('/api/v1/me/passkeys/registration-options'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ password }),
      });
      if (!optionsRes.ok) throw new Error(await errorMessage(optionsRes, 'Could not start passkey setup.'));
      const { data } = (await optionsRes.json()) as {
        data: { ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON };
      };
      let response;
      try {
        response = await createPasskey(data.options);
      } catch (err) {
        throw new Error(passkeyErrorMessage(err, 'Passkey setup failed.'));
      }
      const res = await fetch(url('/api/v1/me/passkeys'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ceremonyId: data.ceremonyId, response, ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, 'Passkey setup failed.'));
      return ((await res.json()) as { data: { recoveryCodes: string[] | null } }).data;
    },
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setPassword('');
      setName('');
      setAdding(false);
      setMessage(null);
      refresh();
      // A first second factor signs out every other session server-side.
      void qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: async (input: { id: string; name: string }) => {
      const res = await fetch(url(`/api/v1/me/passkeys/${encodeURIComponent(input.id)}`), {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: input.name }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, 'Rename failed.'));
    },
    onSuccess: () => {
      setRenaming(null);
      setMessage(null);
      refresh();
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: async (input: { id: string; password: string }) => {
      const res = await fetch(url(`/api/v1/me/passkeys/${encodeURIComponent(input.id)}`), {
        method: 'DELETE',
        headers: headers(),
        body: JSON.stringify({ password: input.password }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, 'Remove failed.'));
      return ((await res.json()) as { data: { signedOut: boolean } }).data;
    },
    onSuccess: (data) => {
      setRemoving(null);
      setMessage(
        data.signedOut
          ? 'Passkey removed. It was your last second factor, so every session was signed out.'
          : null,
      );
      refresh();
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const rows = query.data?.passkeys ?? [];
  const canAdd = supported && query.data?.available !== false;

  return (
    <section className="space-y-3 rounded-md border border-border bg-background p-4">
      <h2 className="flex items-center gap-2 font-medium">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        Passkeys
      </h2>
      <p className="text-sm text-muted-foreground">
        Sign in with your device&apos;s fingerprint, face or screen lock instead of a password, or use a passkey as
        your second factor.
      </p>

      {message ? (
        <p role="alert" className="text-sm text-red-600">{message}</p>
      ) : null}

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-red-600">Could not load passkeys. Reload to try again.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No passkeys yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label="Passkeys">
          {rows.map((p) => (
            <li key={p.id} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.backedUp ? 'Synced' : 'This device only'} · added {formatDate(p.createdAt)} · last used{' '}
                    {formatDate(p.lastUsedAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 text-xs"
                    onClick={() => setRenaming({ id: p.id, name: p.name })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-destructive px-2 py-1 text-xs text-destructive"
                    onClick={() => setRemoving({ id: p.id, password: '' })}
                  >
                    Remove
                  </button>
                </div>
              </div>
              {renaming?.id === p.id ? (
                <div className="flex flex-wrap gap-2">
                  <input
                    aria-label="Passkey name"
                    value={renaming.name}
                    maxLength={64}
                    onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    disabled={renameMutation.isPending || renaming.name.trim().length === 0}
                    onClick={() => renameMutation.mutate({ id: p.id, name: renaming.name.trim() })}
                    className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-60"
                  >
                    Save
                  </button>
                  <button type="button" className="text-xs" onClick={() => setRenaming(null)}>Cancel</button>
                </div>
              ) : null}
              {removing?.id === p.id ? (
                <div className="flex flex-wrap gap-2">
                  <input
                    type="password"
                    aria-label="Password to confirm removal"
                    placeholder="Password"
                    autoComplete="current-password"
                    value={removing.password}
                    onChange={(e) => setRemoving({ id: p.id, password: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    disabled={removeMutation.isPending || removing.password.length === 0}
                    onClick={() => removeMutation.mutate(removing)}
                    className="rounded-md border border-destructive px-3 py-1 text-xs text-destructive disabled:opacity-60"
                  >
                    Confirm remove
                  </button>
                  <button type="button" className="text-xs" onClick={() => setRemoving(null)}>Cancel</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {query.isSuccess && rows.length > 0 && !query.data.totpEnabled ? (
        <p className="text-xs text-muted-foreground">
          {query.data.recoveryCodesRemaining} recovery codes remaining.
        </p>
      ) : null}

      {recoveryCodes?.length ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
          <p className="font-medium">Save these recovery codes — shown once. They let you in if you lose your passkey.</p>
          <ul className="space-y-1 font-mono text-xs">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!canAdd ? (
        <p className="text-sm text-muted-foreground">
          {supported
            ? 'Passkeys are not configured for this server address. Ask an administrator to set WEBAUTHN_ORIGINS.'
            : 'Adding a passkey needs a browser with passkey support; the desktop app cannot create one.'}
        </p>
      ) : !adding ? (
        <button
          type="button"
          onClick={() => {
            setAdding(true);
            setMessage(null);
          }}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Add a passkey
        </button>
      ) : (
        <div className="space-y-3">
          <label htmlFor={nameId} className="block text-sm font-medium">Name (optional)</label>
          <input
            id={nameId}
            value={name}
            maxLength={64}
            placeholder="e.g. Work laptop"
            onChange={(e) => setName(e.target.value)}
            className="block w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <label htmlFor={passwordId} className="block text-sm font-medium">Confirm password</label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="block w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={addMutation.isPending || password.length === 0}
              onClick={() => addMutation.mutate()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Continue
            </button>
            <button type="button" className="text-sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
