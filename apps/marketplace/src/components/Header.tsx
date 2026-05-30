"use client";

import Link from "next/link";
import { useState } from "react";
import { Layers, Menu, X } from "lucide-react";

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-surface-700/60 bg-surface-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 group"
          aria-label="LumiBase Marketplace Home"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 shadow-lg shadow-brand-900/30 group-hover:shadow-brand-700/40 transition-shadow">
            <Layers className="h-4 w-4 text-white" />
          </div>
          <div className="leading-none">
            <span className="text-sm font-bold text-gray-100">LumiBase</span>
            <span className="ml-1.5 text-xs text-brand-400 font-medium">
              Marketplace
            </span>
          </div>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 sm:flex" aria-label="Main navigation">
          <Link
            href="/extensions/"
            id="nav-extensions"
            className="rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-surface-700 hover:text-gray-100 transition-colors"
          >
            Extensions
          </Link>
          <Link
            href="https://docs.lumibase.dev"
            target="_blank"
            rel="noopener noreferrer"
            id="nav-docs"
            className="rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-surface-700 hover:text-gray-100 transition-colors"
          >
            Docs
          </Link>
          <a
            href="https://github.com/khuepm/lumibase"
            target="_blank"
            rel="noopener noreferrer"
            id="nav-github"
            className="ml-2 rounded-lg border border-surface-600 bg-surface-800 px-3 py-1.5 text-sm text-gray-300 hover:border-surface-500 hover:text-gray-100 transition-colors"
          >
            GitHub
          </a>
        </nav>

        {/* Mobile menu toggle */}
        <button
          onClick={() => setOpen(!open)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-surface-700 sm:hidden transition-colors"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="border-t border-surface-700 bg-surface-900 px-4 py-3 sm:hidden">
          <nav className="flex flex-col gap-1" aria-label="Mobile navigation">
            <Link
              href="/extensions/"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm text-gray-300 hover:bg-surface-700 hover:text-gray-100"
            >
              Extensions
            </Link>
            <Link
              href="https://docs.lumibase.dev"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2.5 text-sm text-gray-300 hover:bg-surface-700 hover:text-gray-100"
            >
              Docs
            </Link>
            <a
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg px-3 py-2.5 text-sm text-gray-300 hover:bg-surface-700 hover:text-gray-100"
            >
              GitHub
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
