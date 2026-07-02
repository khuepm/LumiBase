import { Search } from "lucide-react";
import { listExtensions, CATEGORIES } from "@/lib/api";
import ExtensionCard from "@/components/ExtensionCard";
import TagChip from "@/components/TagChip";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LumiBase Marketplace — Extend your Content OS",
};

const PUBLISH_URL = "https://docs.lumibase.dev/extensions/create";

export default async function HomePage() {
  const featured = await listExtensions({ sort: "popular", perPage: 6 });

  return (
    <div className="flex flex-col">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="px-5 pb-5 pt-16 text-center md:pt-20">
        <h1 className="mx-auto text-[40px] font-bold leading-[48px] tracking-[-0.4px] text-white md:text-[60px] md:leading-[70px]">
          Extend your Content OS.
        </h1>
        <p className="mx-auto mt-5 max-w-[480px] text-[19px] font-medium leading-[31px] text-txt-secondary">
          Browse, install, and publish extensions that give your agents new
          skills.
        </p>

        {/* Glass search pill */}
        <form
          action="/extensions/"
          method="get"
          role="search"
          className="glass-pill mx-auto mt-[34px] flex max-w-[560px] items-center gap-2.5 py-2 pl-5 pr-2"
        >
          <Search
            className="h-[18px] w-[18px] flex-shrink-0 text-txt-faint"
            aria-hidden
          />
          <input
            type="text"
            name="q"
            id="hero-search"
            placeholder="Search extensions and skills"
            aria-label="Search extensions"
            className="h-10 min-w-0 flex-1 border-none bg-transparent text-[15px] font-medium text-white outline-none placeholder:text-txt-faint"
          />
          <button type="submit" className="btn-pill btn-primary btn-sm h-10">
            <span>Search</span>
          </button>
        </form>

        {/* Category chips */}
        <div className="mx-auto mt-[30px] flex max-w-[720px] flex-wrap justify-center gap-[9px]">
          <TagChip href="/extensions/" active id="home-cat-all">
            All
          </TagChip>
          {CATEGORIES.map((cat) => (
            <TagChip
              key={cat.slug}
              href={`/categories/${cat.slug}/`}
              id={`home-cat-${cat.slug}`}
            >
              {cat.label}
            </TagChip>
          ))}
        </div>
      </section>

      {/* ── Featured extensions ───────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-[1140px] px-6 pt-14">
        <div className="mb-7 flex items-baseline justify-between">
          <h2 className="text-[26px] font-bold tracking-[-0.3px] text-white">
            Featured extensions
          </h2>
          <span className="text-sm font-medium text-txt-faint">
            {featured.total} total
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {featured.data.map((ext) => (
            <ExtensionCard key={ext.id} extension={ext} />
          ))}
        </div>
      </section>

      {/* ── Publish CTA ──────────────────────────────────────────────────── */}
      <section className="mx-auto mt-28 w-full max-w-[1140px] px-6">
        <div
          className="relative flex flex-col items-start gap-8 overflow-hidden rounded-[28px] p-8 shadow-[inset_0_0_0_1px_rgba(255,255,255,.10)] md:flex-row md:items-center md:justify-between md:px-12 md:py-[52px]"
          style={{
            background:
              "linear-gradient(135deg, rgba(123,97,255,.16), rgba(24,160,251,.08))",
          }}
        >
          {/* Decorative planet sphere */}
          <div
            aria-hidden
            className="absolute -right-10 -top-10 h-[220px] w-[220px] rounded-full opacity-50"
            style={{
              background:
                "radial-gradient(circle at 34% 30%, #fff 0%, #7B61FF 58%, #26204a 100%)",
              boxShadow: "0 0 80px rgba(123,97,255,.4)",
            }}
          />
          <div className="relative max-w-[560px]">
            <h2 className="text-[28px] font-bold tracking-[-0.4px] text-white md:text-[34px]">
              Publish your extension.
            </h2>
            <p className="mt-3 text-base font-medium leading-[26px] text-[rgb(205,205,210)]">
              Ship a skill to every agent on the platform. Provenance,
              versioning and review are handled — you write the logic.
            </p>
          </div>
          <div className="relative flex-shrink-0">
            <a
              href={PUBLISH_URL}
              target="_blank"
              rel="noopener noreferrer"
              id="cta-create-ext"
              className="btn-pill btn-primary btn-md"
            >
              <span>Start building</span>
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
