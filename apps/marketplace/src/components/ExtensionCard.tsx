import Link from "next/link";
import { Download, Star, ArrowRight } from "lucide-react";
import type { Extension } from "@/lib/types";
import TagBadge from "./TagBadge";

interface ExtensionCardProps {
  extension: Extension;
  featured?: boolean;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function ExtensionCard({
  extension,
  featured = false,
}: ExtensionCardProps) {
  const {
    slug,
    name,
    description,
    category,
    tags,
    publisherName,
    latestVersion,
    rating,
    ratingCount,
  } = extension;

  return (
    <Link
      href={`/extensions/${slug}/`}
      id={`ext-card-${slug}`}
      className={`group relative flex flex-col rounded-xl border transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-brand-900/20 ${
        featured
          ? "border-brand-700/50 bg-gradient-to-b from-brand-950/80 to-surface-800 hover:border-brand-600/60"
          : "border-surface-600 bg-surface-800 hover:border-surface-500"
      }`}
    >
      {featured && (
        <div className="absolute -top-px left-4 right-4 h-px bg-gradient-to-r from-transparent via-brand-500/60 to-transparent" />
      )}

      <div className="flex flex-1 flex-col p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-900/60 text-brand-400 text-lg font-bold border border-brand-800/50">
            {name[0]}
          </div>
          <span className="mt-0.5 text-xs text-gray-500">v{latestVersion}</span>
        </div>

        {/* Name & publisher */}
        <div className="mt-3">
          <h3 className="font-semibold text-gray-100 group-hover:text-brand-300 transition-colors">
            {name}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">{publisherName}</p>
        </div>

        {/* Description */}
        <p className="mt-2.5 line-clamp-2 flex-1 text-sm text-gray-400 leading-relaxed">
          {description}
        </p>

        {/* Tags */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <TagBadge label={category} variant="category" />
          {tags.slice(0, 2).map((tag) => (
            <TagBadge key={tag} label={tag} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-surface-700/60 px-5 py-3">
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {extension.totalDownloads ? (
            <span className="flex items-center gap-1">
              <Download className="h-3.5 w-3.5" />
              {formatNumber(extension.totalDownloads)}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Download className="h-3.5 w-3.5" />
              New
            </span>
          )}
          {rating != null && ratingCount != null && ratingCount > 0 && (
            <span className="flex items-center gap-1">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              {rating.toFixed(1)}
              <span className="text-gray-600">({ratingCount})</span>
            </span>
          )}
        </div>
        <ArrowRight className="h-4 w-4 text-gray-600 transition-all group-hover:translate-x-0.5 group-hover:text-brand-400" />
      </div>
    </Link>
  );
}
