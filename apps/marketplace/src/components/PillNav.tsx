"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface PillNavItem {
  label: string;
  href: string;
  external?: boolean;
}

interface PillNavProps {
  items: PillNavItem[];
  className?: string;
}

/**
 * Injects the shared Liquid Glass SVG displacement filters once.
 * Applied via `backdrop-filter: ... url(#dgmLens)`.
 */
function ensureLiquidGlass(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("dgm-liquid-glass-defs")) return;
  const wrap = document.createElement("div");
  wrap.id = "dgm-liquid-glass-defs";
  wrap.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
  wrap.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="dgmLens" x="-35%" y="-35%" width="170%" height="170%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.009 0.013" numOctaves="2" seed="7" result="noise">
            <animate attributeName="baseFrequency" dur="11s" repeatCount="indefinite"
              values="0.009 0.013; 0.015 0.008; 0.007 0.016; 0.009 0.013" calcMode="spline"
              keySplines="0.45 0 0.55 1; 0.45 0 0.55 1; 0.45 0 0.55 1" />
          </feTurbulence>
          <feGaussianBlur in="noise" stdDeviation="1.6" result="sn" />
          <feDisplacementMap in="SourceGraphic" in2="sn" scale="58"
            xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>`;
  document.body.appendChild(wrap);
}

function isItemActive(item: PillNavItem, pathname: string): boolean {
  if (item.external) return false;
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(item.href);
}

/**
 * Liquid-glass pill navigation — translucent material with a sliding glass
 * "lozenge" behind the active item. Ported from the LumiBase design system.
 */
export default function PillNav({ items, className = "" }: PillNavProps) {
  const pathname = usePathname();
  const active = items.find((item) => isItemActive(item, pathname))?.label;
  const wrapRef = useRef<HTMLElement | null>(null);
  const btnRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false });

  useEffect(() => {
    ensureLiquidGlass();
  }, []);

  const measure = useCallback(() => {
    if (!active) {
      setThumb((t) => ({ ...t, ready: false }));
      return;
    }
    const el = btnRefs.current[active];
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const w = wrap.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    setThumb({ left: b.left - w.left, width: b.width, ready: true });
  }, [active]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <nav
      ref={wrapRef}
      aria-label="Main navigation"
      className={className}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: 5,
        borderRadius: 999,
        overflow: "hidden",
        isolation: "isolate",
        boxShadow: [
          "inset 0 1px 0 rgba(255,255,255,0.6)",
          "inset 0 0 0 1px rgba(255,255,255,0.14)",
          "inset 1px 0 6px rgba(255,255,255,0.18)",
          "inset -1px 0 6px rgba(255,255,255,0.18)",
          "inset 0 -10px 22px rgba(0,0,0,0.32)",
          "0 10px 34px -6px rgba(0,0,0,0.6)",
          "0 2px 6px rgba(0,0,0,0.35)",
        ].join(", "),
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 999,
          zIndex: 0,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.05) 48%, rgba(255,255,255,0.02) 100%)",
          backdropFilter: "blur(7px) saturate(185%) url(#dgmLens)",
          WebkitBackdropFilter: "blur(7px) saturate(185%)",
        }}
      />
      {thumb.ready && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 5,
            left: thumb.left,
            width: thumb.width,
            height: "calc(100% - 10px)",
            borderRadius: 999,
            zIndex: 1,
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.34) 0%, rgba(255,255,255,0.12) 100%)",
            backdropFilter: "blur(1px) saturate(170%) brightness(1.16)",
            WebkitBackdropFilter: "blur(1px) saturate(170%) brightness(1.16)",
            boxShadow: [
              "inset 0 1px 0 rgba(255,255,255,0.85)",
              "inset 0 0 0 1px rgba(255,255,255,0.3)",
              "inset 0 -6px 12px rgba(0,0,0,0.18)",
              "0 6px 16px -2px rgba(0,0,0,0.45)",
            ].join(", "),
            transition:
              "left 620ms cubic-bezier(0.34,1.56,0.64,1), width 620ms cubic-bezier(0.34,1.56,0.64,1)",
          }}
        />
      )}
      {items.map((item) => {
        const isActive = active === item.label;
        const style: React.CSSProperties = {
          position: "relative",
          zIndex: 2,
          display: "inline-flex",
          alignItems: "center",
          height: 38,
          padding: "0 18px",
          borderRadius: 999,
          fontWeight: 600,
          fontSize: 13,
          lineHeight: 1,
          letterSpacing: "0.2px",
          whiteSpace: "nowrap",
          textDecoration: "none",
          color: isActive ? "#fff" : "rgba(255,255,255,0.66)",
          textShadow: isActive ? "0 1px 2px rgba(0,0,0,0.35)" : "none",
          transition: "color 240ms cubic-bezier(0.22,1,0.36,1)",
        };
        const hoverHandlers = {
          onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => {
            if (!isActive) e.currentTarget.style.color = "rgba(255,255,255,0.92)";
          },
          onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => {
            if (!isActive) e.currentTarget.style.color = "rgba(255,255,255,0.66)";
          },
        };
        if (item.external) {
          return (
            <a
              key={item.label}
              ref={(n) => {
                btnRefs.current[item.label] = n;
              }}
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              style={style}
              {...hoverHandlers}
            >
              {item.label}
            </a>
          );
        }
        return (
          <Link
            key={item.label}
            ref={(n) => {
              btnRefs.current[item.label] = n;
            }}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            style={style}
            {...hoverHandlers}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
