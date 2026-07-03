"use client";

import { useState, useCallback } from "react";
import { Copy, Check, Package } from "lucide-react";

interface InstallSlugProps {
  slug: string;
}

export default function InstallSlug({ slug }: InstallSlugProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(slug);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const el = document.createElement("textarea");
      el.value = slug;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [slug]);

  return (
    <div className="rounded-[18px] bg-surface-1 p-[22px] ring-glass">
      <div className="mb-3 flex items-center gap-2">
        <Package className="h-4 w-4 text-accent-violet" />
        <span className="text-sm font-semibold text-white">
          Install in Studio
        </span>
      </div>
      <p className="mb-3 text-xs font-medium leading-[18px] text-txt-faint">
        Open Studio → Settings → Marketplace, then paste the slug below.
      </p>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate rounded-xl bg-surface-sunken px-3 py-2.5 font-mono text-sm text-[#c9bcff] ring-glass">
          {slug}
        </div>
        <button
          id={`copy-slug-${slug}`}
          onClick={handleCopy}
          aria-label={copied ? "Copied!" : `Copy slug ${slug}`}
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl transition-all duration-200 ${
            copied
              ? "bg-[rgba(46,196,124,.16)] text-accent-green shadow-[inset_0_0_0_1px_rgba(46,196,124,.30)]"
              : "bg-surface-3 text-txt-secondary ring-glass hover:text-white"
          }`}
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
      </div>
      {copied && (
        <p className="animate-fade-in mt-2 text-xs font-medium text-accent-green">
          Copied to clipboard
        </p>
      )}
    </div>
  );
}
