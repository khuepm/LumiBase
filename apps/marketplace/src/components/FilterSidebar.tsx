"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { CATEGORIES } from "@/lib/api";
import TagChip from "./TagChip";

const SORT_OPTIONS = [
  { value: "popular", label: "Most installed" },
  { value: "latest", label: "Recently updated" },
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
      className="w-full space-y-7 lg:w-56 xl:w-64"
      aria-label="Filter extensions"
    >
      {/* Sort */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[.6px] text-[rgb(130,130,138)]">
          Sort by
        </h3>
        <div className="space-y-1">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              id={`sort-${opt.value}`}
              onClick={() => setParam("sort", opt.value)}
              className={`w-full rounded-[10px] px-3 py-[7px] text-left text-sm transition-colors ${
                activeSort === opt.value
                  ? "bg-[rgba(123,97,255,.16)] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(123,97,255,.30)]"
                  : "font-medium text-[rgb(170,170,176)] hover:text-white"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Categories */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[.6px] text-[rgb(130,130,138)]">
          Category
        </h3>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <TagChip
              key={cat.slug}
              id={`filter-cat-${cat.slug}`}
              active={activeCategory === cat.slug}
              onClick={() => toggleCategory(cat.slug)}
            >
              {cat.label}
            </TagChip>
          ))}
        </div>
      </div>

      {/* Clear filters */}
      {hasFilters && (
        <button
          id="clear-filters"
          onClick={clearAll}
          className="btn-pill btn-glass btn-sm w-full"
        >
          <span>Clear filters</span>
        </button>
      )}
    </aside>
  );
}
