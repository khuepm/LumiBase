import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getExtension, getAllSlugs } from "@/lib/api";
import TagBadge from "@/components/TagBadge";
import VersionHistory from "@/components/VersionHistory";
import InstallSlug from "@/components/InstallSlug";
import {
  ChevronLeft,
  Download,
  Star,
  ExternalLink,
  Github,
  Calendar,
  Scale,
} from "lucide-react";

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

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDate(iso: string | null) {
  if (!iso) return "Unknown";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
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
    publishedAt,
    updatedAt,
    repositoryUrl,
    documentationUrl,
    licenseType,
    versions,
  } = ext;

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-8">
        <Link
          href="/extensions/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to Extensions
        </Link>
      </nav>

      <div className="grid gap-10 lg:grid-cols-3">
        {/* ── Main content ──────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-8">
          {/* Header */}
          <div className="flex items-start gap-5">
            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-brand-900/60 border border-brand-800/50 text-2xl font-bold text-brand-300">
              {name[0]}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold text-gray-50">{name}</h1>
              <p className="mt-1 text-sm text-gray-500">
                by <span className="text-gray-400">{publisherName}</span>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <TagBadge label={category} variant="category" size="md" />
                {tags.map((tag) => (
                  <TagBadge key={tag} label={tag} size="md" />
                ))}
              </div>
            </div>
          </div>

          {/* Description */}
          <p className="text-gray-300 leading-relaxed text-base">{description}</p>

          {/* README */}
          <div>
            <h2 className="mb-4 text-lg font-semibold text-gray-100">Documentation</h2>
            <div className="prose-dark rounded-xl border border-surface-600 bg-surface-800/60 p-6">
              {renderSimpleMarkdown(readme)}
            </div>
          </div>

          {/* Version history */}
          <VersionHistory versions={versions} />
        </div>

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <aside className="space-y-5">
          {/* Install */}
          <InstallSlug slug={slug} />

          {/* Stats */}
          <div className="rounded-xl border border-surface-600 bg-surface-800 divide-y divide-surface-700">
            <div className="px-5 py-3.5">
              <h3 className="text-sm font-semibold text-gray-200">Details</h3>
            </div>
            <div className="px-5 py-3 flex items-center justify-between text-sm">
              <span className="text-gray-500">Latest version</span>
              <span className="font-mono text-gray-200">v{latestVersion}</span>
            </div>
            {ext.totalDownloads ? (
              <div className="px-5 py-3 flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-gray-500">
                  <Download className="h-3.5 w-3.5" />
                  Downloads
                </span>
                <span className="text-gray-200">{formatNumber(ext.totalDownloads)}</span>
              </div>
            ) : null}
            {rating != null && ratingCount != null && ratingCount > 0 && (
              <div className="px-5 py-3 flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-gray-500">
                  <Star className="h-3.5 w-3.5" />
                  Rating
                </span>
                <span className="text-gray-200">
                  {rating.toFixed(1)}
                  <span className="text-gray-600 ml-1">({ratingCount})</span>
                </span>
              </div>
            )}
            {licenseType && (
              <div className="px-5 py-3 flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-gray-500">
                  <Scale className="h-3.5 w-3.5" />
                  License
                </span>
                <span className="text-gray-200">{licenseType}</span>
              </div>
            )}
            <div className="px-5 py-3 flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-gray-500">
                <Calendar className="h-3.5 w-3.5" />
                Published
              </span>
              <span className="text-gray-400 text-xs">{formatDate(publishedAt)}</span>
            </div>
            <div className="px-5 py-3 flex items-center justify-between text-sm">
              <span className="text-gray-500">Updated</span>
              <span className="text-gray-400 text-xs">{formatDate(updatedAt)}</span>
            </div>
          </div>

          {/* Links */}
          {(repositoryUrl || documentationUrl) && (
            <div className="rounded-xl border border-surface-600 bg-surface-800 divide-y divide-surface-700">
              <div className="px-5 py-3.5">
                <h3 className="text-sm font-semibold text-gray-200">Links</h3>
              </div>
              {repositoryUrl && (
                <a
                  href={repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  id={`ext-repo-${slug}`}
                  className="flex items-center gap-2 px-5 py-3 text-sm text-gray-400 hover:text-gray-200 hover:bg-surface-700 transition-colors"
                >
                  <Github className="h-4 w-4" />
                  Source Code
                  <ExternalLink className="ml-auto h-3.5 w-3.5 text-gray-600" />
                </a>
              )}
              {documentationUrl && (
                <a
                  href={documentationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  id={`ext-docs-${slug}`}
                  className="flex items-center gap-2 px-5 py-3 text-sm text-gray-400 hover:text-gray-200 hover:bg-surface-700 transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                  Documentation
                  <ExternalLink className="ml-auto h-3.5 w-3.5 text-gray-600" />
                </a>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
