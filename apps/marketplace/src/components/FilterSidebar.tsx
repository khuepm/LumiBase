"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { CATEGORIES } from "@/lib/api";
import { Filter } from "lucide-react";

const SORT_OPTIONS = [
  { value: "popular", label: "Most Popular" },
  { value: "latest", label: "Recently Updated" },
  { value: "name", label: "Name (A–Z)" },
];

export default function FilterSidebar() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const activeCategory = searchParams.get("category") ?? "";
  const activeSort = searchParams.get("sort") ?? "popular";

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete("page");
      router.push(`/extensions/?${params.toString()}`);
    },
    [router, searchParams]
  );

  const toggleCategory = (slug: string) => {
    setParam("category", activeCategory === slug ? "" : slug);
  };

  const clearAll = () => {
    router.push("/extensions/");
  };

  const hasFilters = activeCategory || searchParams.get("q");

  return (
    <aside
      className="w-full space-y-6 lg:w-56 xl:w-64"
      aria-label="Filter extensions"
    >
      {/* Sort */}
      <div>
        <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
          <Filter className="h-3.5 w-3.5" />
          Sort by
        </h3>
        <div className="space-y-1">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              id={`sort-${opt.value}`}
              onClick={() => setParam("sort", opt.value)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                activeSort === opt.value
                  ? "bg-brand-900/60 text-brand-300 font-medium"
                  : "text-gray-400 hover:bg-surface-700 hover:text-gray-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Categories */}
      <div>
        <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Category
        </h3>
        <div className="space-y-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.slug}
              id={`filter-cat-${cat.slug}`}
              onClick={() => toggleCategory(cat.slug)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                activeCategory === cat.slug
                  ? "bg-brand-900/60 text-brand-300 font-medium"
                  : "text-gray-400 hover:bg-surface-700 hover:text-gray-200"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Clear filters */}
      {hasFilters && (
        <button
          id="clear-filters"
          onClick={clearAll}
          className="w-full rounded-lg border border-surface-600 py-2 text-sm text-gray-400 hover:border-surface-500 hover:text-gray-200 transition-colors"
        >
          Clear filters
        </button>
      )}
    </aside>
  );
}
