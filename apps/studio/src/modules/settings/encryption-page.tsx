import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Loader2, Lock, ShieldCheck } from 'lucide-react';

/**
 * Encryption settings — envelope (per-record DEK) mode toggle
 * (regulated-content-readiness task 3.6; Req 4.5).
 *
 * Envelope mode is an operator-controlled setting (NOT a raw env var) so it
 * cannot be flipped accidentally and every change is audited. Changing it
 * requires the admin to re-enter their password (step-up auth); the server
 * then runs a background migration that converts existing records to the new
 * mode. Reads stay correct throughout because every record is self-describing
 * (its stored wrapped DEK is the source of truth).
 *
 * Consumes:
 *   GET  /api/v1/admin/encryption/envelope  → { data: EnvelopeSetting }
 *   POST /api/v1/admin/encryption/envelope  { enabled, password }
 *   POST /api/v1/admin/encryption/envelope/migrate  (drain more batches)
 */

interface MigrationState {
  direction: 'to_envelope' | 'to_shared' | null;
  status: 'idle' | 'running' | 'completed';
  cursor: string | null;
  processed: number;
  startedAt: string | null;
  updatedAt: string | null;
}
interface EnvelopeSetting {
  enabled: boolean;
  migration: MigrationState;
}

const BASE = '/api/v1/admin/encryption/envelope';

async function fetchEnvelope(): Promise<EnvelopeSetting> {
  const res = await fetch(BASE, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 403 ? 'Admin access required.' : 'Failed to load encryption settings.');
  const json = (await res.json()) as { data: EnvelopeSetting };
  return json.data;
}

async function setEnvelope(enabled: boolean, password: string): Promise<void> {
  const res = await fetch(BASE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ enabled, password }),
  });
  if (res.ok) return;
  let code = 'UNKNOWN';
  try {
    const body = (await res.json()) as { errors?: { code?: string; message?: string }[] };
    code = body.errors?.[0]?.code ?? code;
    if (res.status === 401) throw new Error('Password verification failed.');
    throw new Error(body.errors?.[0]?.message ?? `Request failed (${code}).`);
  } catch (e) {
    if (e instanceof Error && e.message) throw e;
    throw new Error(`Request failed (${res.status}).`);
  }
}

async function drainMigration(): Promise<void> {
  await fetch(`${BASE}/migrate`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
}

export function EncryptionSettingsPage() {
  const qc = useQueryClient();
  const passwordFieldId = useId();
  const [password, setPassword] = useState('');
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);

  const settingQuery = useQuery({ queryKey: ['encryption-envelope'], queryFn: fetchEnvelope });
  const setting = settingQuery.data;
  const migrating = setting?.migration.status === 'running';

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => setEnvelope(enabled, password),
    onSuccess: () => {
      setPassword('');
      setPendingEnabled(null);
      void qc.invalidateQueries({ queryKey: ['encryption-envelope'] });
    },
  });

  const drainMutation = useMutation({
    mutationFn: drainMigration,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['encryption-envelope'] }),
  });

  function confirmToggle() {
    if (pendingEnabled === null || password.length === 0) return;
    toggleMutation.mutate(pendingEnabled);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Lock className="size-5" aria-hidden /> Encryption
        </h1>
        <p className="text-sm text-muted-foreground">
          Envelope encryption gives every record its own data key (DEK) wrapped by your key-encryption
          key (KEK). This enables per-record crypto-shredding for GDPR erasure. Changing the mode runs a
          background migration of existing records; reads stay correct throughout.
        </p>
      </header>

      {settingQuery.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
        </p>
      )}
      {settingQuery.isError && (
        <p className="text-sm text-destructive">{(settingQuery.error as Error).message}</p>
      )}

      {setting && (
        <section className="space-y-4 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Envelope mode</p>
              <p className="text-sm text-muted-foreground">
                Currently{' '}
                <span className={setting.enabled ? 'text-emerald-600' : 'text-muted-foreground'}>
                  {setting.enabled ? 'enabled' : 'disabled'}
                </span>
                .
              </p>
            </div>
            {setting.enabled ? (
              <ShieldCheck className="size-6 text-emerald-600" aria-hidden />
            ) : null}
          </div>

          {migrating && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Migration in progress
              </p>
              <p className="text-muted-foreground">
                {setting.migration.direction === 'to_envelope' ? 'Converting to envelope' : 'Converting to shared key'} —{' '}
                {setting.migration.processed} record(s) migrated.
              </p>
              <button
                type="button"
                className="mt-2 rounded border px-2 py-1 text-xs hover:bg-background"
                onClick={() => drainMutation.mutate()}
                disabled={drainMutation.isPending}
              >
                {drainMutation.isPending ? 'Draining…' : 'Continue migration'}
              </button>
            </div>
          )}

          {/* Step-up: confirm the change by re-entering the admin password. */}
          {pendingEnabled === null ? (
            <button
              type="button"
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
              onClick={() => setPendingEnabled(!setting.enabled)}
              disabled={migrating}
            >
              {setting.enabled ? 'Disable envelope mode' : 'Enable envelope mode'}
            </button>
          ) : (
            <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium">
                Confirm: {pendingEnabled ? 'enable' : 'disable'} envelope mode
              </p>
              <p className="text-xs text-muted-foreground">
                Re-enter your password to authorize this change. A background migration will start
                immediately.
              </p>
              <label htmlFor={passwordFieldId} className="block text-sm">
                Your password
                <input
                  id={passwordFieldId}
                  type="password"
                  autoComplete="current-password"
                  className="mt-1 w-full rounded border px-2 py-1"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {toggleMutation.isError && (
                <p className="text-sm text-destructive">{(toggleMutation.error as Error).message}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  onClick={confirmToggle}
                  disabled={password.length === 0 || toggleMutation.isPending}
                >
                  {toggleMutation.isPending ? 'Applying…' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="rounded-md border px-3 py-2 text-sm"
                  onClick={() => {
                    setPendingEnabled(null);
                    setPassword('');
                    toggleMutation.reset();
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
