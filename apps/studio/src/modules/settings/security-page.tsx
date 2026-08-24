import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Loader2, Shield } from 'lucide-react';
import { getActiveSite } from '@/lib/api';

interface TotpStatus {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

const headers = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'X-Lumi-Site': getActiveSite(),
  'X-Lumi-Client': 'studio',
});

async function fetchStatus(): Promise<TotpStatus> {
  const res = await fetch('/api/v1/me/tfa', { credentials: 'same-origin', headers: headers() });
  if (!res.ok) throw new Error('Failed to load two-factor settings.');
  const json = (await res.json()) as { data: TotpStatus };
  return json.data;
}

export function SecuritySettingsPage() {
  const qc = useQueryClient();
  const passwordId = useId();
  const codeId = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const statusQuery = useQuery({ queryKey: ['me-tfa'], queryFn: fetchStatus });
  const enabled = statusQuery.data?.enabled ?? false;

  const setupMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v1/me/tfa/setup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers(),
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => null) as { data?: { secret?: string; otpauthUrl?: string }; errors?: { message?: string }[] };
      if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? 'Setup failed.');
      return body.data!;
    },
    onSuccess: (data) => {
      setSetupSecret(data.secret ?? null);
      setOtpauthUrl(data.otpauthUrl ?? null);
      setPassword('');
      setMessage(null);
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!setupSecret) throw new Error('Start setup first.');
      const res = await fetch('/api/v1/me/tfa/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: headers(),
        body: JSON.stringify({ secret: setupSecret, code }),
      });
      const body = await res.json().catch(() => null) as { data?: { recoveryCodes?: string[] }; errors?: { message?: string }[] };
      if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? 'Confirmation failed.');
      return body.data!.recoveryCodes ?? [];
    },
    onSuccess: (codes) => {
      setRecoveryCodes(codes);
      setSetupSecret(null);
      setOtpauthUrl(null);
      setCode('');
      void qc.invalidateQueries({ queryKey: ['me-tfa'] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const disableMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v1/me/tfa', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: headers(),
        body: JSON.stringify({ password, code }),
      });
      const body = await res.json().catch(() => null) as { errors?: { message?: string }[] };
      if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? 'Disable failed.');
    },
    onSuccess: () => {
      setPassword('');
      setCode('');
      setRecoveryCodes(null);
      void qc.invalidateQueries({ queryKey: ['me-tfa'] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Shield className="h-5 w-5" aria-hidden="true" />
          Security
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage two-factor authentication for your account.
        </p>
      </header>

      {message ? (
        <p role="alert" className="text-sm text-red-600">{message}</p>
      ) : null}

      <section className="rounded-md border border-border bg-background p-4 space-y-3">
        <h2 className="font-medium">Two-factor authentication (TOTP)</h2>
        <p className="text-sm text-muted-foreground">
          Status: {enabled ? 'Enabled' : 'Disabled'}
          {enabled && statusQuery.data?.recoveryCodesRemaining != null
            ? ` · ${statusQuery.data.recoveryCodesRemaining} recovery codes remaining`
            : null}
        </p>

        {!enabled && !setupSecret ? (
          <div className="space-y-3">
            <label htmlFor={passwordId} className="block text-sm font-medium">Confirm password to begin setup</label>
            <input
              id={passwordId}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-md border border-border px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={setupMutation.isPending || password.length === 0}
              onClick={() => setupMutation.mutate()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {setupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Enable 2FA
            </button>
          </div>
        ) : null}

        {setupSecret ? (
          <div className="space-y-3">
            <p className="text-sm">Add this secret to your authenticator app:</p>
            <code className="block break-all rounded bg-muted p-2 text-xs">{setupSecret}</code>
            {otpauthUrl ? (
              <p className="text-xs text-muted-foreground break-all">URI: {otpauthUrl}</p>
            ) : null}
            <label htmlFor={codeId} className="block text-sm font-medium">Enter the 6-digit code</label>
            <input
              id={codeId}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="block w-full rounded-md border border-border px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={confirmMutation.isPending || code.length < 6}
              onClick={() => confirmMutation.mutate()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              Confirm and enable
            </button>
          </div>
        ) : null}

        {recoveryCodes?.length ? (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
            <p className="font-medium">Save these recovery codes — shown once:</p>
            <ul className="font-mono text-xs space-y-1">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {enabled ? (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-sm font-medium">Disable 2FA</p>
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-md border border-border px-3 py-2 text-sm"
            />
            <input
              type="text"
              inputMode="numeric"
              placeholder="Current TOTP code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="block w-full rounded-md border border-border px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={disableMutation.isPending}
              onClick={() => disableMutation.mutate()}
              className="rounded-md border border-destructive px-4 py-2 text-sm text-destructive"
            >
              Disable 2FA
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default SecuritySettingsPage;
