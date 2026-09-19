"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./Header.module.css";

const links = [
  { href: "/#content-os", label: "Product" },
  { href: "https://docs.lumibase.dev", label: "Docs" },
  { href: "https://github.com/khuepm/lumibase", label: "GitHub" },
];

export default function Header() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={styles.header}>
      <a href="#main-content" className={styles.skip}>
        Skip to content
      </a>
      <Link
        href="/#top"
        className={styles.brand}
        onClick={() => setOpen(false)}
        aria-label="LumiBase home"
      >
        <Image
          src="/assets/iridescent/wordmark.webp"
          width={1500}
          height={297}
          alt="LumiBase"
          sizes="145px"
        />
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
        key={pathname}
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
