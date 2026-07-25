import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const TABS: Array<{ id: string; label: string; to: string }> = [
  { id: 'roles', label: 'Roles', to: '/access/roles' },
  { id: 'policies', label: 'Policies', to: '/access/policies' },
  { id: 'public', label: 'Public & subscribers', to: '/access/public' },
  { id: 'api-keys', label: 'API keys', to: '/access/api-keys' },
  { id: 'import-export', label: 'Import / export', to: '/access/import-export' },
  { id: 'matrix', label: 'Permission matrix', to: '/access/matrix' },
  { id: 'sandbox', label: 'Test sandbox', to: '/access/sandbox' },
];

interface AccessLayoutProps {
  children: ReactNode;
}

/**
 * Access Control module shell. Renders a top-bar of section tabs and slots
 * the active page underneath. The active tab is derived from the router
 * location so the layout remains pure markup.
 */
export function AccessLayout({ children }: AccessLayoutProps) {
  const { location } = useRouterState();
  const activeTab = TABS.find((t) => location.pathname.startsWith(t.to))?.id ?? 'roles';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Access control</h1>
        <p className="text-sm text-muted-foreground">
          Roles bundle policies; policies bundle permission rules. Use the
          matrix to audit and the sandbox to debug a verdict.
        </p>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={t.to}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              activeTab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <section>{children}</section>
    </div>
  );
}
