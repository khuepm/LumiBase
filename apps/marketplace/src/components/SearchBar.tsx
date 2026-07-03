"use client";

import { useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

interface SearchBarProps {
  placeholder?: string;
  className?: string;
}

export default function SearchBar({
  placeholder = "Search extensions and skills",
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
    <div
      className={`glass-pill flex items-center gap-2.5 py-2 pl-5 pr-2 ${className}`}
    >
      <Search
        className="h-[18px] w-[18px] flex-shrink-0 text-txt-faint"
        aria-hidden
      />
      <input
        ref={inputRef}
        id="marketplace-search"
        type="search"
        defaultValue={currentQ}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label="Search extensions"
        className="h-9 min-w-0 flex-1 border-none bg-transparent text-[15px] font-medium text-white outline-none placeholder:text-txt-faint [&::-webkit-search-cancel-button]:hidden"
      />
      {currentQ && (
        <button
          onClick={handleClear}
          aria-label="Clear search"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-txt-faint transition-colors hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
