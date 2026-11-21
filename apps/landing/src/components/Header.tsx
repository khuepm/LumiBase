"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import LumiMark from "@/components/storybook/LumiMark";
import styles from "./Header.module.css";

const links = [
  { href: "/#content-os", label: "Product" },
  { href: "https://docs.lumibase.dev", label: "Docs" },
  { href: "https://github.com/khuepm/lumibase", label: "GitHub" },
];

export default function Header() {
  const pathname = usePathname();
  // The menu belongs to the page it was opened on, so any navigation —
  // back/forward included — closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (next: boolean) => setOpenOn(next ? pathname : null);
  const header = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenOn(null);
        menuButton.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) setOpenOn(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <header ref={header} className={styles.header}>
      <a href="#main-content" className={styles.skip}>
        Skip to content
      </a>
      <Link
        href="/#top"
        className={styles.brand}
        onClick={() => setOpen(false)}
        aria-label="LumiBase home"
      >
        <LumiMark size={38} />
        <span>LumiBase</span>
      </Link>
      <nav className={styles.desktopNav} aria-label="Main navigation">
        {links.map((link) => (
          <Link href={link.href} key={link.label}>
            {link.label}
          </Link>
        ))}
      </nav>
      <Link href="https://github.com/khuepm/lumibase" className={styles.start}>
        Start building <ArrowRight size={15} aria-hidden="true" />
      </Link>
      <button
        ref={menuButton}
        className={styles.menuButton}
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="mobile-navigation"
        onClick={() => setOpen(!open)}
      >
        {open ? <X size={23} /> : <Menu size={23} />}
      </button>
      <nav
        id="mobile-navigation"
        className={styles.mobileNav}
        aria-label="Mobile navigation"
        hidden={!open}
      >
        {links.map((link) => (
          <Link
            href={link.href}
            key={link.label}
            onClick={() => setOpen(false)}
          >
            {link.label}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        ))}
        <Link href="/#ai-harness" onClick={() => setOpen(false)}>
          Earned autonomy
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
        <Link href="/#studio" onClick={() => setOpen(false)}>
          Mission Control
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </nav>
    </header>
  );
}
