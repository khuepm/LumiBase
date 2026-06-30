import { useRef, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { docTreeUnion } from 'virtual:docs-registry';
import { Sidebar } from './Sidebar';
import { SearchDialog } from './SearchDialog';
import { TableOfContents } from './TableOfContents';
import { LocaleSwitcher } from './LocaleSwitcher';
import { siteConfig, resolveLabel } from '../lib/site-config';
import { useLocale } from '../hooks/useLocale';
import { useCurrentSlug } from '../hooks/useCurrentSlug';
import { useT } from '../hooks/useT';
import { pathFor } from '../lib/url';

/**
 * App layout shell with three-column responsive structure.
 *
 * - Left: Sidebar (hidden on mobile <768px, togglable via hamburger)
 * - Center: Content area (renders child routes via Outlet)
 * - Right: Table of Contents panel (visible only on screens >1024px)
 *
 * Requirements: 3.6, 6.2
 */
export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const { locale } = useLocale();
  const t = useT();

  // Extract the active slug from the current route path using parseUrl
  const activeSlug = useCurrentSlug();

  const handleNavigate = (slug: string) => {
    navigate(pathFor(locale, slug));
    // Close sidebar on mobile after navigation
    setSidebarOpen(false);
  };

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      {/* Mobile overlay when sidebar is open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — left column */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 w-64 transform border-r bg-background transition-transform duration-200 ease-in-out
          md:relative md:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Close button for mobile */}
        <div className="flex h-14 items-center justify-between border-b px-4 md:hidden">
          <span className="text-sm font-semibold">Navigation</span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            aria-label="Close sidebar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Sidebar navigation tree */}
        <div className="overflow-y-auto h-full">
          <Sidebar
            tree={docTreeUnion}
            activeSlug={activeSlug}
            onNavigate={handleNavigate}
            locale={locale}
          />
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar with hamburger toggle (mobile) and search (all screens) */}
        <header className="flex h-14 items-center border-b px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent md:hidden"
            aria-label="Open sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="ml-3 text-sm font-semibold md:hidden">{siteConfig.title} Docs</span>
          <span className="hidden text-sm font-semibold md:inline">{siteConfig.title} Docs</span>
          <a
            href={`https://github.com/khuepm/lumibase/releases/tag/v${__APP_VERSION__}`}
            target="_blank"
            rel="noreferrer"
            title={t('version.badge-tooltip')}
            className="ml-2 inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
          >
            v{__APP_VERSION__}
          </a>
          <nav aria-label="Primary" className="ml-6 hidden items-center gap-4 md:flex">
            {siteConfig.navbar.items
              .filter((item) => item.position !== 'right')
              .map((item) => {
                const label = resolveLabel(item.label, locale);
                return item.href ? (
                  <a
                    key={label}
                    href={item.href}
                    className="text-sm text-muted-foreground hover:text-foreground"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {label}
                  </a>
                ) : (
                  <a
                    key={label}
                    href={item.to}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {label}
                  </a>
                );
              })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SearchDialog />
            <LocaleSwitcher />
            {siteConfig.navbar.items
              .filter((item) => item.position === 'right')
              .map((item) => {
                const label = resolveLabel(item.label, locale);
                return (
                  <a
                    key={label}
                    href={item.href ?? item.to}
                    target={item.href ? '_blank' : undefined}
                    rel={item.href ? 'noreferrer' : undefined}
                    className="hidden text-sm text-muted-foreground hover:text-foreground md:inline"
                  >
                    {label}
                  </a>
                );
              })}
          </div>
        </header>

        {/* Content + ToC wrapper */}
        <div className="flex flex-1 overflow-hidden">
          {/* Center column — page content */}
          <main ref={contentRef} className="flex flex-1 flex-col overflow-y-auto">
            <Outlet />
            <footer
              className={`mt-auto border-t px-6 py-6 text-xs ${siteConfig.footer.style === 'dark'
                ? 'border-zinc-800 bg-zinc-900 text-zinc-400'
                : 'bg-muted text-muted-foreground'
                }`}
            >
              <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {siteConfig.footer.links.map((col, colIdx) => (
              <div key={colIdx}>
                <h3
                  className={`mb-2 text-sm font-semibold ${siteConfig.footer.style === 'dark'
                    ? 'text-zinc-100'
                    : 'text-foreground'
                    }`}
                >
                  {resolveLabel(col.title, locale)}
                </h3>
                <ul className="space-y-1">
                  {col.items.map((item, itemIdx) => (
                    <li key={itemIdx}>
                      <a
                        className={`hover:underline ${siteConfig.footer.style === 'dark'
                          ? 'hover:text-zinc-100'
                          : 'hover:text-foreground'
                          }`}
                        href={item.href ?? item.to}
                        target={item.href ? '_blank' : undefined}
                        rel={item.href ? 'noreferrer' : undefined}
                      >
                        {resolveLabel(item.label, locale)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p
            className={`mt-6 border-t pt-4 text-center ${siteConfig.footer.style === 'dark' ? 'border-zinc-800' : ''
              }`}
          >
            {siteConfig.footer.copyright.split('LumiBase').map((part, i, arr) =>
              i < arr.length - 1 ? (
                <span key={i}>
                  {part}
                  <a
                    href="https://lumibase.dev"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    LumiBase
                  </a>
                </span>
                  ) : (
                    <span key={i}>{part}</span>
                  ),
                )}
              </p>
            </footer>
          </main>

          {/* Right column — Table of Contents (visible only >1024px) */}
          <aside className="hidden w-56 shrink-0 overflow-y-auto border-l p-4 lg:block">
            <div className="sticky top-4">
              <TableOfContents contentRef={contentRef} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
