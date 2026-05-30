import { Suspense } from "react";
import type { Metadata } from "next";
import ExtensionsClient from "./ExtensionsClient";

export const metadata: Metadata = {
  title: "Extensions",
  description:
    "Browse all LumiBase extensions. Filter by category, tags, or search by name.",
};

export default function ExtensionsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <span className="text-sm text-gray-500">Loading extensions…</span>
          </div>
        </div>
      }
    >
      <ExtensionsClient />
    </Suspense>
  );
}
