"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Github, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import PillNav from "@/components/cosmic/PillNav";
import { EclipseMark } from "@/components/EclipseMark";
import { useLenis } from "@/components/scroll/SmoothScroll";

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
