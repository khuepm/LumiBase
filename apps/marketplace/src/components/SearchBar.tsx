"use client";

import { useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

interface SearchBarProps {
  placeholder?: string;
  className?: string;
}

export default function SearchBar({
  placeholder = "Search extensions…",
  className = "",
}: SearchBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentQ = searchParams.get("q") ?? "";

  const push = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("q", value);
      } else {
        params.delete("q");
      }
      params.delete("page");
      router.push(`/extensions/?${params.toString()}`);
    },
    [router, searchParams]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => push(e.target.value), 400);
  };

  const handleClear = () => {
    if (inputRef.current) inputRef.current.value = "";
    push("");
  };

  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
      <input
        ref={inputRef}
        id="marketplace-search"
        type="search"
        defaultValue={currentQ}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label="Search extensions"
        className="h-10 w-full rounded-xl border border-surface-600 bg-surface-800 pl-10 pr-9 text-sm text-gray-200 placeholder-gray-500 transition-all focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
      />
      {currentQ && (
        <button
          onClick={handleClear}
          aria-label="Clear search"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
