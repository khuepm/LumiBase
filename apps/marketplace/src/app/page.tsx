import Link from "next/link";
import { ArrowRight, Puzzle, TrendingUp, Zap } from "lucide-react";
import { getFeaturedExtensions, CATEGORIES } from "@/lib/api";
import ExtensionCard from "@/components/ExtensionCard";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LumiBase Marketplace — Discover Extensions",
};

export default async function HomePage() {
  const featured = await getFeaturedExtensions();

  return (
    <div className="flex flex-col">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-6 pt-20 pb-16 md:pt-28 md:pb-20 hero-grid">
        {/* Glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-hero-glow"
        />
        <div className="relative mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand-800/60 bg-brand-950/60 px-4 py-1.5 text-xs font-medium text-brand-400 mb-6 backdrop-blur-sm">
            <Puzzle className="h-3.5 w-3.5" />
            Extension Marketplace
          </div>

          <h1 className="text-4xl font-extrabold tracking-tight text-gray-50 sm:text-5xl md:text-6xl text-balance">
            Extend LumiBase with{" "}
            <span className="bg-gradient-to-r from-brand-400 to-indigo-400 bg-clip-text text-transparent">
              Powerful Plugins
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg text-gray-400 leading-relaxed text-balance">
            Browse community and official extensions to add SEO, analytics,
            media optimization, e-commerce, and more to your headless CMS in
            seconds.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/extensions/"
              id="hero-browse"
              className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-900/30 hover:bg-brand-500 hover:-translate-y-0.5 transition-all active:translate-y-0"
            >
              Browse Extensions
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="https://docs.lumibase.dev/extensions/create"
              target="_blank"
              rel="noopener noreferrer"
              id="hero-publish"
              className="inline-flex items-center gap-2 rounded-xl border border-surface-600 px-6 py-3 text-sm font-semibold text-gray-300 hover:border-surface-500 hover:text-gray-100 hover:-translate-y-0.5 transition-all"
            >
              Publish an Extension
            </a>
          </div>

          {/* Stats */}
          <div className="mt-14 flex flex-wrap items-center justify-center gap-8 text-center">
            {[
              { label: "Extensions", value: "6+", icon: Puzzle },
              { label: "Downloads", value: "73k+", icon: TrendingUp },
              { label: "Categories", value: "6", icon: Zap },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-1.5 text-2xl font-bold text-gray-100">
                  <Icon className="h-5 w-5 text-brand-400" />
                  {value}
                </div>
                <span className="text-xs text-gray-500">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Featured Extensions ───────────────────────────────────────────── */}
      <section className="px-6 py-16 md:py-20">
        <div className="mx-auto max-w-7xl">
          <div className="mb-8 flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-100">
                Featured Extensions
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Top picks from the community
              </p>
            </div>
            <Link
              href="/extensions/"
              id="featured-view-all"
              className="flex items-center gap-1 text-sm text-brand-400 hover:text-brand-300 transition-colors"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((ext) => (
              <ExtensionCard key={ext.id} extension={ext} featured />
            ))}
          </div>
        </div>
      </section>

      {/* ── Categories ───────────────────────────────────────────────────── */}
      <section className="px-6 py-16 md:py-20 border-t border-surface-800">
        <div className="mx-auto max-w-7xl">
          <h2 className="mb-8 text-2xl font-bold text-gray-100">
            Browse by Category
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
            {CATEGORIES.map((cat) => (
              <Link
                key={cat.slug}
                href={`/categories/${cat.slug}/`}
                id={`home-cat-${cat.slug}`}
                className="group flex flex-col items-center gap-3 rounded-xl border border-surface-600 bg-surface-800 p-5 text-center hover:border-brand-700/60 hover:bg-surface-700 transition-all hover:-translate-y-0.5"
              >
                <div className="h-10 w-10 rounded-xl bg-brand-900/60 border border-brand-800/40 flex items-center justify-center text-brand-400 font-bold text-lg group-hover:bg-brand-800/60 transition-colors">
                  {cat.label[0]}
                </div>
                <span className="text-sm font-medium text-gray-300 group-hover:text-gray-100 transition-colors">
                  {cat.label}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────── */}
      <section className="px-6 py-16 md:py-20">
        <div className="mx-auto max-w-4xl rounded-2xl border border-brand-800/40 bg-gradient-to-br from-brand-950 via-surface-800 to-surface-900 p-10 text-center relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-hero-glow opacity-40"
          />
          <div className="relative">
            <h2 className="text-2xl font-bold text-gray-50 sm:text-3xl">
              Build and publish your own extension
            </h2>
            <p className="mt-3 text-gray-400">
              Share your work with the community. Extensions are open-source
              and reviewed by the LumiBase team.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <a
                href="https://docs.lumibase.dev/extensions/create"
                target="_blank"
                rel="noopener noreferrer"
                id="cta-create-ext"
                className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-900/30 hover:bg-brand-500 hover:-translate-y-0.5 transition-all"
              >
                Get Started
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
