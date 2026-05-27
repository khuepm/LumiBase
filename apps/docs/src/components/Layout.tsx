import { useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { docTree } from 'virtual:docs-registry';
import { Sidebar } from './Sidebar';
import { SearchDialog } from './SearchDialog';
import { TableOfContents } from './TableOfContents';
import { siteConfig } from '../lib/site-config';

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
  const location = useLocation();
  const navigate = useNavigate();

  // Extract the active slug from the current route path
  // Route pattern is /docs/:slug* so we strip the /docs/ prefix
  const activeSlug = location.pathname.startsWith('/docs/')
    ? location.pathname.slice('/docs/'.length)
    : '';

  const handleNavigate = (slug: string) => {
    navigate(`/docs/${slug}`);
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
            tree={docTree}
            activeSlug={activeSlug}
            onNavigate={handleNavigate}
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
          <nav aria-label="Primary" className="ml-6 hidden items-center gap-4 md:flex">
            {siteConfig.navbar.items
              .filter((item) => item.position !== 'right')
              .map((item) =>
                item.href ? (
                  <a
                    key={item.label}
                    href={item.href}
                    className="text-sm text-muted-foreground hover:text-foreground"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.label}
                  </a>
                ) : (
                  <a
                    key={item.label}
                    href={item.to}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    {item.label}
                  </a>
                ),
              )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SearchDialog />
            {siteConfig.navbar.items
              .filter((item) => item.position === 'right')
              .map((item) => (
                <a
                  key={item.label}
                  href={item.href ?? item.to}
                  target={item.href ? '_blank' : undefined}
                  rel={item.href ? 'noreferrer' : undefined}
                  className="hidden text-sm text-muted-foreground hover:text-foreground md:inline"
                >
                  {item.label}
                </a>
              ))}
          </div>
        </header>

        {/* Content + ToC wrapper */}
        <div className="flex flex-1 overflow-hidden">
          {/* Center column — page content */}
          <main ref={contentRef} className="flex-1 overflow-y-auto">
            <Outlet />
          </main>

          {/* Right column — Table of Contents (visible only >1024px) */}
          <aside className="hidden w-56 shrink-0 overflow-y-auto border-l p-4 lg:block">
            <div className="sticky top-4">
              <TableOfContents contentRef={contentRef} />
            </div>
          </aside>
        </div>

        <footer
          className={`border-t px-6 py-6 text-xs ${siteConfig.footer.style === 'dark'
              ? 'border-zinc-800 bg-zinc-900 text-zinc-400'
              : 'bg-muted text-muted-foreground'
            }`}
        >
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {siteConfig.footer.links.map((col) => (
              <div key={col.title}>
                <h3
                  className={`mb-2 text-sm font-semibold ${siteConfig.footer.style === 'dark'
                      ? 'text-zinc-100'
                      : 'text-foreground'
                    }`}
                >
                  {col.title}
                </h3>
                <ul className="space-y-1">
                  {col.items.map((item) => (
                    <li key={item.label}>
                      <a
                        className={`hover:underline ${siteConfig.footer.style === 'dark'
                            ? 'hover:text-zinc-100'
                            : 'hover:text-foreground'
                          }`}
                        href={item.href ?? item.to}
                        target={item.href ? '_blank' : undefined}
                        rel={item.href ? 'noreferrer' : undefined}
                      >
                        {item.label}
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
            {siteConfig.footer.copyright}
          </p>
        </footer>
      </div>
    </div>
  );
}
