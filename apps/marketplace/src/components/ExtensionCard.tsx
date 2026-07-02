import Link from "next/link";
import type { Extension } from "@/lib/types";
import { categoryAccent, categoryLabel, formatInstalls } from "@/lib/design";
import PlanetIcon from "./PlanetIcon";
import Badge from "./Badge";

interface ExtensionCardProps {
  extension: Extension;
  featured?: boolean;
}

export default function ExtensionCard({ extension }: ExtensionCardProps) {
  const { slug, name, description, category, publisherName, totalDownloads } =
    extension;
  const accent = categoryAccent(category);

  return (
    <Link
      href={`/extensions/${slug}/`}
      id={`ext-card-${slug}`}
      className="surface-card group flex flex-col gap-4 p-6 transition-transform duration-300 hover:-translate-y-0.5"
    >
      {/* Header row: planet icon + category badge */}
      <div className="flex items-start justify-between">
        <PlanetIcon accent={accent} size={46} radius={14} glow={30} />
        <Badge tone={accent} dot>
          {categoryLabel(category)}
        </Badge>
      </div>

      {/* Name + description */}
      <div>
        <h3 className="text-[19px] font-semibold tracking-[-0.2px] text-white">
          {name}
        </h3>
        <p className="mt-2 text-sm font-medium leading-[22px] text-txt-secondary">
          {description}
        </p>
      </div>

      {/* Footer: publisher · installs + Install */}
      <div className="mt-auto flex items-center justify-between">
        <span className="text-[13px] font-medium text-txt-faint">
          {publisherName} · {formatInstalls(totalDownloads)}
        </span>
        <span className="btn-pill btn-glass btn-sm" aria-hidden>
          <span>Install</span>
        </span>
      </div>
    </Link>
  );
}
