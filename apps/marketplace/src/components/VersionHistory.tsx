import type { ExtensionVersion } from "@/lib/types";
import Badge from "./Badge";

interface VersionHistoryProps {
  versions: ExtensionVersion[];
}

function formatDate(iso: string | null) {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * "What's new" changelog — latest release as a highlighted card (green badge),
 * older releases as compact hairline-divided rows below.
 */
export default function VersionHistory({ versions }: VersionHistoryProps) {
  if (versions.length === 0) return null;
  const [latest, ...older] = versions;

  return (
    <div className="space-y-3">
      {/* Latest release */}
      <div className="rounded-2xl bg-surface-1 px-[22px] py-5 ring-glass">
        <div className="mb-3 flex items-center gap-2.5">
          <Badge tone="green" dot>
            v{latest.version}
          </Badge>
          <span className="text-[13px] font-medium text-txt-faint">
            Released {formatDate(latest.publishedAt)}
          </span>
          {latest.sha256 && (
            <code className="ml-auto hidden rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-txt-faint sm:inline">
              {latest.sha256.slice(0, 8)}…
            </code>
          )}
        </div>
        {latest.changelog && (
          <p className="text-sm font-medium leading-[25px] text-[rgb(185,185,192)]">
            {latest.changelog}
          </p>
        )}
      </div>

      {/* Older releases */}
      {older.length > 0 && (
        <div className="rounded-2xl bg-surface-1 ring-glass">
          {older.map((v, i) => (
            <div
              key={v.id}
              className={`px-[22px] py-4 ${i > 0 ? "border-t border-hairline" : ""}`}
            >
              <div className="flex items-center gap-2.5">
                <Badge tone="neutral" dot={false}>
                  v{v.version}
                </Badge>
                <span className="text-xs font-medium text-txt-faint">
                  {formatDate(v.publishedAt)}
                </span>
                {v.sha256 && (
                  <code className="ml-auto hidden rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-txt-faint sm:inline">
                    {v.sha256.slice(0, 8)}…
                  </code>
                )}
              </div>
              {v.changelog && (
                <p className="mt-2 text-[13px] font-medium leading-[21px] text-[rgb(170,170,178)]">
                  {v.changelog}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
