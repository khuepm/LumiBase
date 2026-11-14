import { useNavigate } from '@tanstack/react-router';
import { KeyRound, LogIn } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { getActiveSite, hasActiveToken, setActiveToken, setActiveRefreshToken, setActiveSite } from '@/lib/api';
import { ADMIN_PATH_REGEX } from '@/modules/setup/schemas/admin-path';
import { passkeyErrorMessage, passkeysSupported, promptPasskey } from '@/lib/passkeys';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

interface AdminLoginPageProps {
  adminPath: string;
}

type LoginStatus = 'idle' | 'submitting' | 'error';
type LoginStep = 'credentials' | 'mfa';

export function AdminLoginPage({ adminPath }: AdminLoginPageProps) {
  const navigate = useNavigate();
  const normalizedAdminPath = useMemo(() => normalizeRouteAdminPath(adminPath), [adminPath]);
  const recoveryBasePath = normalizedAdminPath ? `${normalizedAdminPath}/recovery` : '/recovery';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<LoginStep>('credentials');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  // Second factors the server will accept for this challenge (#735). An older
  // server sends none, which means TOTP.
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const canUsePasskey = useMemo(() => passkeysSupported(), []);
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  if (!normalizedAdminPath) {
    return <AdminLoginNotFound />;
  }

  useEffect(() => {
    if (normalizedAdminPath && hasActiveToken()) {
      navigate({ to: normalizedAdminPath });
    }
  }, [navigate, normalizedAdminPath]);

  const finishLogin = useCallback(
    (token: string, refreshToken?: string) => {
      setActiveSite(getActiveSite());
      setActiveToken(token);
      if (refreshToken) setActiveRefreshToken(refreshToken);
      navigate({ to: normalizedAdminPath });
    },
    [navigate, normalizedAdminPath],
  );

  const onSubmitCredentials = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setStatus('submitting');
      setMessage(null);

      try {
        const response = await fetch('/api/v1/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Lumi-Site': getActiveSite(),
            'X-Lumi-Client': 'studio',
          },
          body: JSON.stringify({ email, password }),
        });

        const body = await response.json().catch(() => null) as {
          data?: { token?: string; refreshToken?: string; status?: string; challengeToken?: string; methods?: string[] };
          errors?: Array<{ message?: string; code?: string }>;
        } | null;

        if (body?.data?.status === 'mfa_required' && body.data.challengeToken) {
          setChallengeToken(body.data.challengeToken);
          setMfaMethods(Array.isArray(body.data.methods) ? body.data.methods : []);
          setStep('mfa');
          setStatus('idle');
          return;
        }

        if (!response.ok || !body?.data?.token) {
          setStatus('error');
          setMessage(body?.errors?.[0]?.message ?? 'Login failed.');
          return;
        }

        finishLogin(body.data.token, body.data.refreshToken);
      } catch {
        setStatus('error');
        setMessage('Could not reach the login service.');
      }
    },
    [email, finishLogin, password],
  );

  const onSubmitMfa = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!challengeToken) return;
      setStatus('submitting');
      setMessage(null);

      try {
        const payload = useRecovery
          ? { challengeToken, recoveryCode }
          : { challengeToken, code: totpCode };

        const response = await fetch('/api/v1/auth/verify-totp', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Lumi-Site': getActiveSite(),
            'X-Lumi-Client': 'studio',
          },
          body: JSON.stringify(payload),
        });

        const body = await response.json().catch(() => null) as {
          data?: { token?: string; refreshToken?: string };
          errors?: Array<{ message?: string }>;
        } | null;

        if (!response.ok || !body?.data?.token) {
          setStatus('error');
          setMessage(body?.errors?.[0]?.message ?? 'Verification failed.');
          return;
        }

        finishLogin(body.data.token, body.data.refreshToken);
      } catch {
        setStatus('error');
        setMessage('Could not reach the login service.');
      }
    },
    [challengeToken, finishLogin, recoveryCode, totpCode, useRecovery],
  );

  /**
   * Passkey ceremony (#735). With a challenge token the passkey is the second
   * factor after the password; without one it is a passwordless sign-in with
   * a discoverable credential. Same session payload either way.
   */
  const onPasskey = useCallback(
    async (mfaChallengeToken?: string) => {
      setStatus('submitting');
      setMessage(null);
      const jsonHeaders = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Lumi-Site': getActiveSite(),
        'X-Lumi-Client': 'studio',
      };
      try {
        const optionsRes = await fetch('/api/v1/auth/passkey/options', {
          method: 'POST',
          credentials: 'same-origin',
          headers: jsonHeaders,
          body: JSON.stringify(mfaChallengeToken ? { challengeToken: mfaChallengeToken } : {}),
        });
        const optionsBody = await optionsRes.json().catch(() => null) as {
          data?: { ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON };
          errors?: Array<{ message?: string }>;
        } | null;
        if (!optionsRes.ok || !optionsBody?.data) {
          setStatus('error');
          setMessage(optionsBody?.errors?.[0]?.message ?? 'Passkey sign-in is not available.');
          return;
        }

        let assertion: AuthenticationResponseJSON;
        try {
          assertion = await promptPasskey(optionsBody.data.options);
        } catch (err) {
          setStatus('error');
          setMessage(passkeyErrorMessage(err, 'Passkey sign-in failed.'));
          return;
        }

        const verifyRes = await fetch('/api/v1/auth/passkey/verify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: jsonHeaders,
          body: JSON.stringify({
            ceremonyId: optionsBody.data.ceremonyId,
            response: assertion,
            ...(mfaChallengeToken ? { challengeToken: mfaChallengeToken } : {}),
          }),
        });
        const verifyBody = await verifyRes.json().catch(() => null) as {
          data?: { token?: string; refreshToken?: string };
          errors?: Array<{ message?: string }>;
        } | null;
        if (!verifyRes.ok || !verifyBody?.data?.token) {
          setStatus('error');
          setMessage(verifyBody?.errors?.[0]?.message ?? 'Passkey sign-in failed.');
          return;
        }
        finishLogin(verifyBody.data.token, verifyBody.data.refreshToken);
      } catch {
        setStatus('error');
        setMessage('Could not reach the login service.');
      }
    },
    [finishLogin],
  );

  const hasTotp = mfaMethods.length === 0 || mfaMethods.includes('totp');
  const hasPasskey = canUsePasskey && mfaMethods.includes('webauthn');
  // With passkeys only, the code form is just the recovery-code fallback.
  const showCodeForm = hasTotp || useRecovery;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <section className="w-full max-w-sm space-y-5 rounded-md border border-border bg-background p-6 shadow-sm">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">LumiBase Login</h1>
          <p className="text-sm text-muted-foreground">
            {step === 'credentials' ? 'Sign in to continue to Studio.' : 'Enter your authentication code.'}
          </p>
        </header>

        {step === 'credentials' ? (
          <form className="space-y-4" onSubmit={onSubmitCredentials}>
            <div className="space-y-1">
              <label htmlFor="admin-login-email" className="block text-sm font-medium">
                Email
              </label>
              <input
                id="admin-login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="admin-login-password" className="block text-sm font-medium">
                Password
              </label>
              <input
                id="admin-login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>

            {message ? (
              <p role="alert" className="text-sm text-red-600">
                {message}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              {status === 'submitting' ? 'Signing in' : 'Sign in'}
            </button>

            {canUsePasskey ? (
              <button
                type="button"
                disabled={status === 'submitting'}
                onClick={() => void onPasskey()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Sign in with a passkey
              </button>
            ) : null}
          </form>
        ) : (
          <form className="space-y-4" onSubmit={onSubmitMfa}>
            {hasPasskey && challengeToken ? (
              <button
                type="button"
                disabled={status === 'submitting'}
                onClick={() => void onPasskey(challengeToken)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Use a passkey
              </button>
            ) : null}
            {!hasTotp && !hasPasskey && !useRecovery ? (
              <p className="text-sm text-muted-foreground">
                This account signs in with a passkey, which is not available here. Use a recovery code instead.
              </p>
            ) : null}

            {!showCodeForm ? null : !useRecovery ? (
              <div className="space-y-1">
                <label htmlFor="admin-login-totp" className="block text-sm font-medium">
                  Authentication code
                </label>
                <input
                  id="admin-login-totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required={!useRecovery}
                  maxLength={8}
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            ) : (
              <div className="space-y-1">
                <label htmlFor="admin-login-recovery" className="block text-sm font-medium">
                  Recovery code
                </label>
                <input
                  id="admin-login-recovery"
                  required={useRecovery}
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            )}

            <button
              type="button"
              className="text-sm text-primary underline-offset-2 hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setMessage(null);
              }}
            >
              {useRecovery
                ? (hasTotp ? 'Use authenticator code instead' : 'Back to passkey')
                : 'Use a recovery code instead'}
            </button>

            {message ? (
              <p role="alert" className="text-sm text-red-600">
                {message}
              </p>
            ) : null}

            {showCodeForm ? (
              <button
                type="submit"
                disabled={status === 'submitting'}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                {status === 'submitting' ? 'Verifying' : 'Verify'}
              </button>
            ) : null}

            <button
              type="button"
              className="w-full text-sm text-muted-foreground"
              onClick={() => {
                setStep('credentials');
                setChallengeToken(null);
                setMfaMethods([]);
                setUseRecovery(false);
                setTotpCode('');
                setRecoveryCode('');
                setMessage(null);
              }}
            >
              Back to sign in
            </button>
          </form>
        )}

        {step === 'credentials' ? (
          <div className="space-y-2 border-t border-border pt-4 text-sm">
            <a
              href={`${recoveryBasePath}/backup-code`}
              className="block font-medium text-primary underline-offset-2 hover:underline"
            >
              Forgot password?
            </a>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function normalizeRouteAdminPath(segment: string): string | null {
  const candidate = `/${segment.replace(/^\/+|\/+$/g, '')}`;
  return ADMIN_PATH_REGEX.test(candidate) ? candidate : null;
}

function AdminLoginNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <section role="alert" className="w-full max-w-sm rounded-md border border-border bg-background p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This admin URL is not valid.
        </p>
      </section>
    </main>
  );
}

export default AdminLoginPage;
