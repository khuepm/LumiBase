"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { listExtensions } from "@/lib/api";
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
    ? category.charAt(0).toUpperCase() + category.slice(1)
    : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-100">
          {activeCategory ? `${activeCategory} Extensions` : "All Extensions"}
        </h1>
        {!loading && (
          <p className="mt-1 text-sm text-gray-500">
            {total} extension{total !== 1 ? "s" : ""} found
            {q ? ` for "${q}"` : ""}
          </p>
        )}
      </div>

      {/* Search bar */}
      <div className="mb-8">
        <SearchBar className="max-w-xl" />
      </div>

      <div className="flex gap-8">
        {/* Sidebar */}
        <FilterSidebar />

        {/* Grid */}
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: PER_PAGE }).map((_, i) => (
                <div
                  key={i}
                  className="h-56 animate-pulse rounded-xl border border-surface-600 bg-surface-800"
                />
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
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 animate-fade-in">
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
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
                      page <= 1
                        ? "pointer-events-none border-surface-700 text-gray-700"
                        : "border-surface-600 text-gray-400 hover:border-surface-500 hover:text-gray-200"
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
                        className={`flex h-9 w-9 items-center justify-center rounded-lg border text-sm font-medium transition-colors ${
                          p === page
                            ? "border-brand-700 bg-brand-900/60 text-brand-300"
                            : "border-surface-600 text-gray-400 hover:border-surface-500 hover:text-gray-200"
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
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
                      page >= totalPages
                        ? "pointer-events-none border-surface-700 text-gray-700"
                        : "border-surface-600 text-gray-400 hover:border-surface-500 hover:text-gray-200"
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
