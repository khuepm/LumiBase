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
    <div className="rounded-xl border border-surface-600 bg-surface-800 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Package className="h-4 w-4 text-brand-400" />
        <span className="text-sm font-semibold text-gray-200">
          Install in Studio
        </span>
      </div>
      <p className="mb-3 text-xs text-gray-400">
        Open your Lumibase Studio → Settings → Marketplace, then search or
        paste the slug below:
      </p>
      <div className="flex items-center gap-2">
        <div className="flex-1 rounded-lg border border-surface-600 bg-surface-950 px-3 py-2.5 font-mono text-sm text-brand-300">
          {slug}
        </div>
        <button
          id={`copy-slug-${slug}`}
          onClick={handleCopy}
          aria-label={copied ? "Copied!" : `Copy slug ${slug}`}
          className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border transition-all duration-200 ${
            copied
              ? "border-green-600/50 bg-green-900/30 text-green-400"
              : "border-surface-600 bg-surface-700 text-gray-300 hover:border-brand-600 hover:bg-brand-900/30 hover:text-brand-300"
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
        <p className="mt-2 text-xs text-green-400 animate-fade-in">
          ✓ Copied to clipboard
        </p>
      )}
    </div>
  );
}
