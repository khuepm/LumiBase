"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import PillNav, { type PillNavItem } from "./PillNav";

const NAV_ITEMS: PillNavItem[] = [
  { label: "Home", href: "/" },
  { label: "Extensions", href: "/extensions/" },
  { label: "Docs", href: "https://docs.lumibase.dev", external: true },
  { label: "GitHub", href: "https://github.com/khuepm/lumibase", external: true },
];

const PUBLISH_URL = "https://docs.lumibase.dev/extensions/create";

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="relative z-40">
      <div className="relative flex h-[72px] items-center justify-between px-5 sm:px-10">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2.5"
          aria-label="LumiBase Marketplace Home"
        >
          <span
            aria-hidden
            className="h-[22px] w-[22px] rounded-full"
            style={{
              background: "linear-gradient(180deg,#fff,#cfcfcf)",
              boxShadow: "0 0 18px rgba(123,97,255,.6)",
            }}
          />
          <span className="text-lg font-bold tracking-[-0.3px] text-white">
            LumiBase
          </span>
          <span className="ml-1.5 border-l border-white/[.14] pl-3 text-[13px] font-semibold text-txt-faint">
            Marketplace
          </span>
        </Link>

        {/* Centered liquid-glass pill nav */}
        <div className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:block">
          <PillNav items={NAV_ITEMS} />
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2.5">
          <a
            href={PUBLISH_URL}
            target="_blank"
            rel="noopener noreferrer"
            id="nav-publish"
            className="btn-pill btn-glass btn-sm hidden sm:inline-flex"
          >
            <span>Publish</span>
          </a>

          {/* Mobile menu toggle */}
          <button
            onClick={() => setOpen(!open)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-txt-secondary transition-colors hover:bg-glass hover:text-white lg:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="mx-4 mb-3 rounded-2xl bg-surface-1 px-3 py-3 ring-glass lg:hidden">
          <nav className="flex flex-col gap-1" aria-label="Mobile navigation">
            {NAV_ITEMS.map((item) =>
              item.external ? (
                <a
                  key={item.label}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="rounded-xl px-3 py-2.5 text-sm font-medium text-txt-secondary transition-colors hover:bg-glass hover:text-white"
                >
                  {item.label}
                </a>
              ) : (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="rounded-xl px-3 py-2.5 text-sm font-medium text-txt-secondary transition-colors hover:bg-glass hover:text-white"
                >
                  {item.label}
                </Link>
              )
            )}
            <a
              href={PUBLISH_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="rounded-xl px-3 py-2.5 text-sm font-medium text-txt-secondary transition-colors hover:bg-glass hover:text-white"
            >
              Publish
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
