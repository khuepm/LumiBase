import { useNavigate } from '@tanstack/react-router';
import { LogIn } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { getActiveSite, hasActiveToken, setActiveToken, setActiveSite } from '@/lib/api';
import { ADMIN_PATH_REGEX } from '@/modules/setup/schemas/admin-path';

interface AdminLoginPageProps {
  adminPath: string;
}

type LoginStatus = 'idle' | 'submitting' | 'error';

export function AdminLoginPage({ adminPath }: AdminLoginPageProps) {
  const navigate = useNavigate();
  const normalizedAdminPath = useMemo(() => normalizeRouteAdminPath(adminPath), [adminPath]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  const onSubmit = useCallback(
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
          },
          body: JSON.stringify({ email, password }),
        });

        const body = await response.json().catch(() => null) as {
          data?: { token?: string };
          errors?: Array<{ message?: string }>;
        } | null;

        if (!response.ok || !body?.data?.token) {
          setStatus('error');
          setMessage(body?.errors?.[0]?.message ?? 'Login failed.');
          return;
        }

        setActiveSite(getActiveSite());
        setActiveToken(body.data.token);
        navigate({ to: normalizedAdminPath });
      } catch {
        setStatus('error');
        setMessage('Could not reach the login service.');
      }
    },
    [email, navigate, normalizedAdminPath, password],
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <section className="w-full max-w-sm space-y-5 rounded-md border border-border bg-background p-6 shadow-sm">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">LumiBase Login</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to continue to Studio.
          </p>
        </header>

        <form className="space-y-4" onSubmit={onSubmit}>
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
        </form>
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
