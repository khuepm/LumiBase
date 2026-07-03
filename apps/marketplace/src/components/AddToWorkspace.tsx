"use client";

import { useCallback, useState } from "react";
import { Check } from "lucide-react";

interface AddToWorkspaceProps {
  slug: string;
}

/** Primary detail-page action — copies the extension slug for Studio install. */
export default function AddToWorkspace({ slug }: AddToWorkspaceProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(slug);
    } catch {
      const el = document.createElement("textarea");
      el.value = slug;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [slug]);

  return (
    <button
      id={`add-to-workspace-${slug}`}
      onClick={handleCopy}
      className="btn-pill btn-primary btn-md w-[180px]"
    >
      {copied ? (
        <span className="inline-flex items-center gap-1.5">
          <Check className="h-4 w-4" />
          Slug copied
        </span>
      ) : (
        <span>Add to workspace</span>
      )}
    </button>
  );
}
