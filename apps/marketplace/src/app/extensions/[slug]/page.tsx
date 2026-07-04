import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getExtension, getAllSlugs, listExtensions, extensionDownloadUrl } from "@/lib/api";
import type { Extension } from "@/lib/types";
import {
  categoryAccent,
  categoryLabel,
  formatInstalls,
  trustLevel,
} from "@/lib/design";
import Badge from "@/components/Badge";
import TagChip from "@/components/TagChip";
import PlanetIcon from "@/components/PlanetIcon";
import VersionHistory from "@/components/VersionHistory";
import InstallSlug from "@/components/InstallSlug";
import AddToWorkspace from "@/components/AddToWorkspace";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export const dynamicParams = false;

export async function generateStaticParams() {
  const slugs = await getAllSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const ext = await getExtension(slug);
  if (!ext) return { title: "Extension Not Found" };
  return {
    title: `${ext.name} — ${ext.publisherName}`,
    description: ext.description,
  };
}

function formatDate(iso: string | null) {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function ratingStars(rating: number): string {
  return "★".repeat(Math.round(rating)) + "☆".repeat(5 - Math.round(rating));
}

/** Render a subset of Markdown to HTML spans. Very lightweight — not a full parser. */
function renderSimpleMarkdown(md: string): React.ReactNode[] {
  return md.split("\n").map((line, i) => {
    if (line.startsWith("# "))
      return <h1 key={i} className="mt-6 first:mt-0">{line.slice(2)}</h1>;
    if (line.startsWith("## "))
      return <h2 key={i}>{line.slice(3)}</h2>;
    if (line.startsWith("### "))
      return <h3 key={i}>{line.slice(4)}</h3>;
    if (line.startsWith("- "))
      return <li key={i}>{line.slice(2)}</li>;
    if (line.trim() === "") return <br key={i} />;
    return <p key={i}>{line}</p>;
  });
}

async function getRelated(ext: Extension): Promise<Extension[]> {
  const sameCategory = await listExtensions({
    category: ext.category,
    sort: "popular",
    perPage: 4,
  });
  const related = sameCategory.data.filter((e) => e.slug !== ext.slug);
  if (related.length >= 3) return related.slice(0, 3);
  // Fill with most-installed extensions from other categories.
  const popular = await listExtensions({ sort: "popular", perPage: 6 });
  for (const e of popular.data) {
    if (related.length >= 3) break;
    if (e.slug !== ext.slug && !related.some((r) => r.slug === e.slug)) {
      related.push(e);
    }
  }
  return related.slice(0, 3);
}

export default async function ExtensionDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const ext = await getExtension(slug);

  if (!ext) notFound();

  const {
    name,
    description,
    readme,
    category,
    tags,
    publisherName,
    latestVersion,
    rating,
    ratingCount,
    updatedAt,
    repositoryUrl,
    licenseType,
    versions,
  } = ext;

  const accent = categoryAccent(category);
  const trust = trustLevel(category);
  const related = await getRelated(ext);

  return (
    <div className="pb-4">
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="mx-auto flex max-w-[1140px] items-center gap-2 px-6 pt-7 text-[13px] font-medium text-[rgb(150,150,156)]"
      >
        <Link href="/" className="transition-colors hover:text-white">
          Marketplace
        </Link>
        <span className="text-[rgb(90,90,96)]">/</span>
        <Link
          href={`/categories/${category}/`}
          className="transition-colors hover:text-white"
        >
          {categoryLabel(category)}
        </Link>
        <span className="text-[rgb(90,90,96)]">/</span>
        <span className="text-[rgb(205,205,210)]">{name}</span>
      </nav>

      {/* Identity header */}
      <header className="mx-auto flex max-w-[1140px] flex-col items-start gap-6 px-6 pt-7 md:flex-row">
        <PlanetIcon
          accent={accent}
          size={88}
          radius={22}
          glow={50}
          className="shadow-[0_20px_44px_rgba(0,0,0,.5)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[30px] font-bold tracking-[-0.5px] text-white md:text-[38px]">
              {name}
            </h1>
            <Badge tone={accent} dot>
              {categoryLabel(category)}
            </Badge>
            {ext.verified && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-[rgba(52,199,123,.14)] px-2.5 py-[5px] text-xs font-semibold text-[#7ee0a8] shadow-[inset_0_0_0_1px_rgba(52,199,123,.30)]">
                ✓ Verified publisher
              </span>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-sm font-medium text-[rgb(175,175,182)]">
            <span className="flex items-center gap-[7px]">
              <span
                aria-hidden
                className="h-4 w-4 rounded-full"
                style={{ background: "linear-gradient(180deg,#fff,#cfcfcf)" }}
              />
              by {publisherName}
            </span>
            {rating != null && ratingCount != null && ratingCount > 0 && (
              <span className="text-gold">
                {ratingStars(rating)}{" "}
                <span className="text-[rgb(175,175,182)]">
                  {rating.toFixed(1)} ({ratingCount.toLocaleString("en-US")})
                </span>
              </span>
            )}
            <span>{formatInstalls(ext.totalDownloads)}</span>
            {(ext.voteCount ?? 0) > 0 && (
              <span className="flex items-center gap-[5px]">
                ▲ {(ext.voteCount ?? 0).toLocaleString("en-US")} votes
              </span>
            )}
          </div>
          <p className="mt-4 max-w-[620px] text-base font-medium leading-[26px] text-[rgb(195,195,200)]">
            {description}
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-row gap-2.5 md:flex-col">
          <AddToWorkspace slug={slug} />
          {repositoryUrl && (
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              id={`ext-repo-${slug}`}
              className="btn-pill btn-glass btn-md w-[180px]"
            >
              <span>View source</span>
            </a>
          )}
        </div>
      </header>

      {/* Body grid */}
      <div className="mx-auto grid max-w-[1140px] gap-10 px-6 pt-11 lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-w-0">
          {/* About / readme */}
          <section>
            <h2 className="text-2xl font-bold tracking-[-0.3px] text-white">
              About this extension
            </h2>
            <div className="prose-dark mt-3.5 max-w-[620px]">
              {renderSimpleMarkdown(readme)}
            </div>
          </section>

          {/* What's new */}
          <section className="mt-10">
            <h2 className="mb-4 text-2xl font-bold tracking-[-0.3px] text-white">
              What&apos;s new · v{latestVersion}
            </h2>
            <VersionHistory versions={versions} />
          </section>
        </main>

        {/* Sidebar */}
        <aside className="space-y-5">
          <div className="flex flex-col gap-4 rounded-[18px] bg-surface-1 p-[22px] ring-glass lg:sticky lg:top-6">
            <div className="flex justify-between text-sm font-medium">
              <span className="text-[rgb(150,150,156)]">Publisher</span>
              <span className="text-white">{publisherName}</span>
            </div>
            <div className="h-px bg-white/[.07]" />
            <div className="flex justify-between text-sm font-medium">
              <span className="text-[rgb(150,150,156)]">Version</span>
              <span className="text-white">{latestVersion}</span>
            </div>
            <div className="flex justify-between text-sm font-medium">
              <span className="text-[rgb(150,150,156)]">Updated</span>
              <span className="text-white">{formatDate(updatedAt)}</span>
            </div>
            {licenseType && (
              <div className="flex justify-between text-sm font-medium">
                <span className="text-[rgb(150,150,156)]">License</span>
                <span className="text-white">{licenseType}</span>
              </div>
            )}
            <div className="h-px bg-white/[.07]" />
            <div>
              <div className="mb-2.5 text-xs font-semibold uppercase tracking-[.6px] text-[rgb(130,130,138)]">
                Trust level required
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-[rgba(123,97,255,.16)] px-2.5 py-[5px] text-xs font-semibold text-[#c9bcff] shadow-[inset_0_0_0_1px_rgba(123,97,255,.30)]">
                  {trust.level}
                </span>
                <span className="text-xs font-medium text-[rgb(150,150,156)]">
                  {trust.note}
                </span>
              </div>
            </div>
            {tags.length > 0 && (
              <>
                <div className="h-px bg-white/[.07]" />
                <div>
                  <div className="mb-2.5 text-xs font-semibold uppercase tracking-[.6px] text-[rgb(130,130,138)]">
                    Works with
                  </div>
                  <div className="flex flex-wrap gap-[7px]">
                    {tags.map((tag) => (
                      <TagChip key={tag}>{tag}</TagChip>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <InstallSlug slug={slug} />

          <a
            href={extensionDownloadUrl(slug)}
            id={`ext-download-${slug}`}
            className="btn-pill btn-glass btn-md w-full justify-center"
            rel="noopener noreferrer"
          >
            <span>Download package</span>
          </a>
        </aside>
      </div>

      {/* Related extensions */}
      {related.length > 0 && (
        <section className="mx-auto max-w-[1140px] px-6 pt-[72px]">
          <h2 className="mb-6 text-2xl font-bold tracking-[-0.3px] text-white">
            Related extensions
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((rel) => (
              <Link
                key={rel.slug}
                href={`/extensions/${rel.slug}/`}
                id={`related-${rel.slug}`}
                className="flex items-start gap-3.5 rounded-[20px] bg-surface-1 p-5 ring-glass transition-transform duration-300 hover:-translate-y-0.5"
              >
                <PlanetIcon
                  accent={categoryAccent(rel.category)}
                  size={42}
                  radius={13}
                  glow={26}
                />
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-white">
                    {rel.name}
                  </div>
                  <p className="mt-[5px] line-clamp-2 text-[12.5px] font-medium leading-5 text-[rgb(170,170,178)]">
                    {rel.description}
                  </p>
                  <div className="mt-2 text-xs font-medium text-[rgb(150,150,156)]">
                    {formatInstalls(rel.totalDownloads)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
