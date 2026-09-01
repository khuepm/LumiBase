"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import PillNav from "@/components/cosmic/PillNav";
import { EclipseMark } from "@/components/EclipseMark";
import { useLenis } from "@/components/scroll/SmoothScroll";

// lucide-react v1 dropped brand marks, so the GitHub logo lives here now.
function Github({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.09 3.29 9.4 7.86 10.93.58.1.79-.25.79-.55v-1.94c-3.2.69-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.63 1.59.23 2.76.12 3.05.74.8 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

const SECTIONS = [
  { label: "AI Harness", slug: "ai-harness" },
  { label: "Content OS", slug: "content-os" },
  { label: "Studio", slug: "studio" },
  { label: "Runtime", slug: "runtime" },
];

const textLinks = [
  { href: "https://docs.lumibase.dev", label: "Docs", external: true },
  { href: "/pricing", label: "Pricing", external: false },
];

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [active, setActive] = useState("AI Harness");
  const pathname = usePathname();
  const router = useRouter();
  const lenisRef = useLenis();
  const isHome = pathname === "/";

  // Scroll-spy: light up the pill of the section in view (home page only)
  useEffect(() => {
    if (!isHome) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const match = SECTIONS.find((s) => s.slug === entry.target.id);
            if (match) setActive(match.label);
          }
        }
      },
      { rootMargin: "-30% 0px -55% 0px" }
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.slug);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [isHome]);

  const onSelect = (label: string) => {
    const section = SECTIONS.find((s) => s.label === label);
    if (!section) return;
    setActive(label);
    if (isHome) {
      const el = document.getElementById(section.slug);
      if (!el) return;
      const top = el.offsetTop - 90;
      const lenis = lenisRef?.current;
      if (lenis) lenis.scrollTo(top);
      else window.scrollTo({ top, behavior: "smooth" });
    } else {
      router.push(`/#${section.slug}`);
    }
  };

  return (
    <header className="sticky top-0 z-50 flex h-[72px] w-full items-center justify-between px-5 md:px-10">
      <Link href="/" className="flex items-center gap-2.5">
        <EclipseMark size={26} />
        <span
          className="uppercase"
          style={{
            font: "800 17px/1 var(--font-sans, inherit)",
            letterSpacing: "0.04em",
            color: "var(--foreground)",
          }}
        >
          LumiBase
        </span>
      </Link>

      {/* Center pill navigation */}
      <div className="absolute left-1/2 hidden -translate-x-1/2 lg:block">
        <PillNav
          items={SECTIONS.map((s) => s.label)}
          active={active}
          onSelect={onSelect}
        />
      </div>

      {/* Desktop right side */}
      <div className="hidden items-center gap-5 md:flex">
        {textLinks.map((l) => (
          <Link
            key={l.label}
            href={l.href}
            {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cream/60 transition-colors hover:text-cream"
          >
            {l.label}
          </Link>
        ))}
        <Link
          href="https://github.com/khuepm/lumibase"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-pill btn-glass h-[38px] px-[18px] text-[13px]"
        >
          <Github className="h-4 w-4" />
          <span>GitHub</span>
        </Link>
      </div>

      {/* Mobile menu button */}
      <button
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        className="text-white md:hidden"
        aria-label="Toggle menu"
      >
        {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
      </button>

      {/* Mobile navigation */}
      {mobileMenuOpen && (
        <div
          className="absolute left-0 right-0 top-[72px] px-6 py-5 md:hidden"
          style={{
            background: "rgba(16,9,4,0.94)",
            backdropFilter: "blur(12px)",
            borderBottom: "1px dashed var(--color-dashline)",
          }}
        >
          <div className="flex flex-col gap-4">
            {SECTIONS.map((s) => (
              <button
                key={s.slug}
                onClick={() => {
                  setMobileMenuOpen(false);
                  onSelect(s.label);
                }}
                className="text-left text-sm font-semibold text-white/80 hover:text-white"
              >
                {s.label}
              </button>
            ))}
            {textLinks.map((l) => (
              <Link
                key={l.label}
                href={l.href}
                {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="text-sm font-semibold text-white/60 hover:text-white"
                onClick={() => setMobileMenuOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <Link
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-pill btn-glass h-[38px] w-fit px-[18px] text-[13px]"
              onClick={() => setMobileMenuOpen(false)}
            >
              <Github className="h-4 w-4" />
              <span>GitHub</span>
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
