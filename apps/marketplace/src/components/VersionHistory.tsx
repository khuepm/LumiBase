import type { ExtensionVersion } from "@/lib/types";
import { Calendar, Shield } from "lucide-react";

interface VersionHistoryProps {
  versions: ExtensionVersion[];
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function VersionHistory({ versions }: VersionHistoryProps) {
  return (
    <div className="rounded-xl border border-surface-600 bg-surface-800 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-700 px-5 py-3.5">
        <Shield className="h-4 w-4 text-brand-400" />
        <h3 className="text-sm font-semibold text-gray-200">Version History</h3>
      </div>
      <div className="divide-y divide-surface-700">
        {versions.map((v, i) => (
          <div key={v.id} className="px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    i === 0
                      ? "bg-brand-900/60 text-brand-300 border border-brand-700/40"
                      : "bg-surface-700 text-gray-400 border border-surface-600"
                  }`}
                >
                  v{v.version}
                  {i === 0 && (
                    <span className="ml-1.5 text-[10px] text-brand-400">
                      latest
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0">
                <Calendar className="h-3.5 w-3.5" />
                {formatDate(v.publishedAt)}
              </div>
            </div>
            {v.changelog && (
              <p className="mt-2 text-xs text-gray-400 leading-relaxed">
                {v.changelog}
              </p>
            )}
            <div className="mt-2 flex items-center gap-1.5">
              <span className="text-[10px] text-gray-600 font-mono">
                SHA256:
              </span>
              <code className="rounded bg-surface-950 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                {v.sha256.slice(0, 8)}…
              </code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
