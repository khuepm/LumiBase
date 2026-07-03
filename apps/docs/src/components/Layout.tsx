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
 * Styled after the LumiBase "dark cosmic" design system (see Docs.dc.html).
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
    <div className="relative flex h-screen w-screen flex-col overflow-hidden">
      {/* Top bar — sticky 72px cosmic glass header */}
      <header className="z-40 flex h-[72px] shrink-0 items-center gap-4 border-b border-white/[0.07] bg-[rgba(16,16,19,0.72)] px-4 backdrop-blur-[12px] md:px-8">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="rounded-md p-1 text-[rgb(155,155,160)] transition-colors hover:text-white md:hidden"
          aria-label="Open sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Brand: glossy sphere logo + wordmark + hairline-divided app label */}
        <div className="flex items-center gap-[9px]">
          <div
            aria-hidden="true"
            className="h-[22px] w-[22px] rounded-full bg-[linear-gradient(180deg,#fff,#cfcfcf)] shadow-[0_0_18px_rgba(123,97,255,0.6)]"
          />
          <span className="text-[18px] font-bold tracking-[-0.3px] text-white">
            {siteConfig.title}
          </span>
          <span className="ml-1.5 border-l border-white/[0.14] pl-3 text-[13px] font-semibold text-[rgb(155,155,160)]">
            Docs
          </span>
        </div>

        <a
          href={`https://github.com/khuepm/lumibase/releases/tag/v${__APP_VERSION__}`}
          target="_blank"
          rel="noreferrer"
          title={t('version.badge-tooltip')}
          className="hidden items-center rounded-full bg-[rgba(123,97,255,0.16)] px-2.5 py-0.5 text-[11px] font-semibold text-[#c9bcff] shadow-[inset_0_0_0_1px_rgba(123,97,255,0.30)] transition-colors hover:bg-[rgba(123,97,255,0.26)] sm:inline-flex"
        >
          v{__APP_VERSION__}
        </a>

        <nav aria-label="Primary" className="ml-4 hidden items-center gap-5 md:flex">
          {siteConfig.navbar.items
            .filter((item) => item.position !== 'right')
            .map((item) => {
              const label = resolveLabel(item.label, locale);
              return item.href ? (
                <a
                  key={label}
                  href={item.href}
                  className="text-[13px] font-medium text-[rgb(155,155,160)] transition-colors hover:text-white"
                  target="_blank"
                  rel="noreferrer"
                >
                  {label}
                </a>
              ) : (
                <a
                  key={label}
                  href={item.to}
                  className="text-[13px] font-medium text-[rgb(155,155,160)] transition-colors hover:text-white"
                >
                  {label}
                </a>
              );
            })}
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
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
                  className="hidden text-[13px] font-medium text-[rgb(155,155,160)] transition-colors hover:text-white md:inline"
                >
                  {label}
                </a>
              );
            })}
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
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
            fixed inset-y-0 left-0 z-40 w-64 transform border-r border-white/[0.07] bg-[rgb(16,16,19)] transition-transform duration-200 ease-in-out
            md:relative md:translate-x-0 md:bg-transparent
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
        >
          {/* Close button for mobile */}
          <div className="flex h-14 items-center justify-between border-b border-white/[0.07] px-4 md:hidden">
            <span className="text-sm font-semibold text-white">Navigation</span>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded-md p-1 text-[rgb(155,155,160)] transition-colors hover:text-white"
              aria-label="Close sidebar"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Sidebar navigation tree */}
          <div className="h-full overflow-y-auto">
            <Sidebar
              tree={docTreeUnion}
              activeSlug={activeSlug}
              onNavigate={handleNavigate}
              locale={locale}
            />
          </div>
        </aside>

        {/* Content + ToC wrapper */}
        <div className="flex flex-1 overflow-hidden">
          {/* Center column — page content */}
          <main ref={contentRef} className="flex flex-1 flex-col overflow-y-auto">
            <Outlet />
            <footer className="mt-auto border-t border-white/[0.07] px-6 py-8 md:px-10">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                {siteConfig.footer.links.map((col, colIdx) => (
                  <div key={colIdx}>
                    <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.6px] text-[rgb(130,130,138)]">
                      {resolveLabel(col.title, locale)}
                    </h3>
                    <ul className="space-y-2">
                      {col.items.map((item, itemIdx) => (
                        <li key={itemIdx}>
                          <a
                            className="text-[13px] font-medium text-[rgb(150,150,156)] transition-colors hover:text-white"
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
              <p className="mt-8 border-t border-white/[0.07] pt-5 text-center text-[13px] font-medium text-[rgb(150,150,156)]">
                {siteConfig.footer.copyright.split('LumiBase').map((part, i, arr) =>
                  i < arr.length - 1 ? (
                    <span key={i}>
                      {part}
                      <a
                        href="https://lumibase.dev"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors hover:text-white hover:underline"
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
          <aside className="hidden w-56 shrink-0 overflow-y-auto p-6 lg:block">
            <div className="sticky top-4">
              <TableOfContents contentRef={contentRef} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
