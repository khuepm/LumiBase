"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface PillNavProps {
  items: string[];
  active: string;
  onSelect: (item: string) => void;
  className?: string;
}

/**
 * Floating liquid-glass pill navigation, ported from the LumiBase design
 * system. Heavy backdrop blur + saturation, a specular top-edge highlight,
 * and a sliding glass "lozenge" behind the active item.
 */
export default function PillNav({ items, active, onSelect, className }: PillNavProps) {
  const wrapRef = useRef<HTMLElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false });

  const measure = useCallback(() => {
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
          backdropFilter: "blur(7px) saturate(185%)",
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
      {items.map((label) => {
        const isActive = active === label;
        return (
          <button
            key={label}
            ref={(n) => {
              btnRefs.current[label] = n;
            }}
            onClick={() => onSelect(label)}
            className="transition-colors duration-200"
            style={{
              position: "relative",
              zIndex: 2,
              height: 38,
              padding: "0 18px",
              border: "none",
              cursor: "pointer",
              background: "transparent",
              borderRadius: 999,
              font: "500 11px/1 var(--font-mono-stack, monospace)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              color: isActive ? "#ffedd7" : "rgba(255,237,215,0.62)",
              textShadow: isActive ? "0 1px 2px rgba(0,0,0,0.35)" : "none",
            }}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}
