"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { listExtensions, CATEGORIES } from "@/lib/api";
import type { Extension } from "@/lib/types";
import ExtensionCard from "@/components/ExtensionCard";
import FilterSidebar from "@/components/FilterSidebar";
import SearchBar from "@/components/SearchBar";
import EmptyState from "@/components/EmptyState";
import { ChevronLeft, ChevronRight } from "lucide-react";

const PER_PAGE = 9;

export default function ExtensionsClient() {
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const category = searchParams.get("category") ?? "";
  const sort = (searchParams.get("sort") as "popular" | "latest" | "name") ?? "popular";
  const page = Number(searchParams.get("page") ?? "1");

  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listExtensions({ q, category, sort, page, perPage: PER_PAGE })
      .then((res) => {
        setExtensions(res.data);
        setTotal(res.total);
        setTotalPages(res.totalPages);
      })
      .finally(() => setLoading(false));
  }, [q, category, sort, page]);

  const buildPageUrl = (p: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(p));
    return `/extensions/?${params.toString()}`;
  };

  const activeCategory = category
    ? CATEGORIES.find((c) => c.slug === category)?.label ??
      category.charAt(0).toUpperCase() + category.slice(1)
    : null;

  return (
    <div className="mx-auto max-w-[1140px] px-6 py-10">
      {/* Page header */}
      <div className="mb-7 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[26px] font-bold tracking-[-0.3px] text-white">
          {activeCategory ? `${activeCategory} extensions` : "All extensions"}
        </h1>
        {!loading && (
          <span className="text-sm font-medium text-txt-faint">
            {total} extension{total !== 1 ? "s" : ""}
            {q ? ` for "${q}"` : ""}
          </span>
        )}
      </div>

      {/* Search bar */}
      <div className="mb-9">
        <SearchBar className="max-w-[560px]" />
      </div>

      <div className="flex flex-col gap-10 lg:flex-row">
        {/* Sidebar */}
        <FilterSidebar />

        {/* Grid */}
        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: PER_PAGE }).map((_, i) => (
                <div key={i} className="surface-card h-56 animate-pulse" />
              ))}
            </div>
          ) : extensions.length === 0 ? (
            <EmptyState
              title={q ? `No results for "${q}"` : "No extensions found"}
              description={
                q
                  ? "Try a different search term or remove some filters."
                  : "Try removing category filters."
              }
            />
          ) : (
            <>
              <div className="animate-fade-in grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {extensions.map((ext) => (
                  <ExtensionCard key={ext.id} extension={ext} />
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-10 flex items-center justify-center gap-2">
                  <a
                    href={buildPageUrl(page - 1)}
                    id="pagination-prev"
                    aria-label="Previous page"
                    aria-disabled={page <= 1}
                    className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                      page <= 1
                        ? "pointer-events-none text-white/20"
                        : "bg-surface-3 text-txt-secondary ring-glass hover:text-white"
                    }`}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </a>

                  {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                    (p) => (
                      <a
                        key={p}
                        href={buildPageUrl(p)}
                        id={`pagination-page-${p}`}
                        aria-label={`Page ${p}`}
                        aria-current={p === page ? "page" : undefined}
                        className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                          p === page
                            ? "bg-accent-violet text-white shadow-[0_8px_24px_-8px_rgba(123,97,255,0.7)]"
                            : "bg-surface-3 text-txt-secondary ring-glass hover:text-white"
                        }`}
                      >
                        {p}
                      </a>
                    )
                  )}

                  <a
                    href={buildPageUrl(page + 1)}
                    id="pagination-next"
                    aria-label="Next page"
                    aria-disabled={page >= totalPages}
                    className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                      page >= totalPages
                        ? "pointer-events-none text-white/20"
                        : "bg-surface-3 text-txt-secondary ring-glass hover:text-white"
                    }`}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
