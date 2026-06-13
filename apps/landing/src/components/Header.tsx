"use client";

import Link from "next/link";
import { Github, Menu, X, Terminal } from "lucide-react";
import { useState } from "react";

const navLinks = [
  { href: "https://docs.lumibase.dev/en/ai-native-vision.md", label: "Vision", external: true },
  { href: "https://docs.lumibase.dev", label: "Docs", external: true },
  { href: "/pricing", label: "Pricing", external: false },
];

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-ink-700 bg-ink-950/80 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-signal-500/40 bg-signal-500/10 text-signal-400">
            <Terminal className="h-4 w-4" />
          </div>
          <span className="font-mono text-lg font-semibold tracking-tight text-foreground">
            Lumi<span className="text-signal-400">Base</span>
          </span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden items-center gap-7 md:flex">
          {navLinks.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className="text-sm font-medium text-gray-400 transition-colors hover:text-signal-400"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="https://github.com/khuepm/lumibase"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-ink-600 bg-ink-800 px-4 py-2 text-sm font-medium text-gray-200 transition-colors hover:border-signal-500/50 hover:text-signal-400"
          >
            <Github className="h-4 w-4" />
            GitHub
          </Link>
        </div>

        {/* Mobile Menu Button */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="text-gray-300 md:hidden"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </nav>

      {/* Mobile Navigation */}
      {mobileMenuOpen && (
        <div className="border-t border-ink-700 bg-ink-950 px-6 py-4 md:hidden">
          <div className="flex flex-col gap-4">
            {navLinks.map((l) => (
              <Link
                key={l.label}
                href={l.href}
                {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="text-sm font-medium text-gray-300 hover:text-signal-400"
                onClick={() => setMobileMenuOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <Link
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-800 px-4 py-2 text-sm font-medium text-gray-200 hover:text-signal-400"
              onClick={() => setMobileMenuOpen(false)}
            >
              <Github className="h-4 w-4" />
              GitHub
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
