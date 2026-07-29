"use client";

import {
  animate,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
} from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * PresenceCursors — multiplayer-style cursor presence, scoped to one section.
 *
 * Inside the AI Harness section the OS cursor is replaced by a branded glyph
 * labelled YOU, and a handful of named agent cursors wander the panel like
 * collaborators in a shared document. It is the section's argument made
 * literal: agents are working in here alongside you.
 *
 * Drop it as the first child of a `position: relative` section — it takes that
 * parent as its pointer surface, so it needs no ref plumbing through Scene.
 * The overlay itself is pointer-events:none, so cards and links stay clickable.
 *
 * Everything switches off when the section scrolls out of view (no animation
 * for a panel nobody is looking at), on coarse-pointer devices, and under
 * prefers-reduced-motion — in each case the native cursor is restored.
 */

type Agent = { name: string; color: string; text: string };

const AGENTS: Agent[] = [
  { name: "agent:writer", color: "#ffb020", text: "#1a1000" },
  { name: "agent:reviewer", color: "#ff4d8d", text: "#2a0011" },
  { name: "agent:translator", color: "#29d8e6", text: "#00191c" },
  { name: "agent:seo", color: "#34e0b4", text: "#001a12" },
];

const YOU_COLOR = "#b06bff";

/** Branded pointer glyph — deliberately not the OS arrow. */
function Glyph({ size, color, you = false }: { size: number; color: string; you?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      style={{
        display: "block",
        overflow: "visible",
        filter: `drop-shadow(0 0 6px ${color}88)`,
      }}
    >
      {/* Kite with a notched tail — reads as a cursor but distinctly ours */}
      <path
        d="M3.5 2.2 L21.5 12.6 L13.4 14.6 L15.2 23.2 L10.6 16.2 L3.5 19 Z"
        fill={color}
        stroke="rgba(7,6,12,0.55)"
        strokeWidth={0.8}
        strokeLinejoin="round"
      />
      {you && (
        // Totality ring at the tip — the eclipse mark, cursor-sized
        <>
          <circle cx="3.5" cy="2.2" r="3.4" stroke={color} strokeWidth="1.1" opacity="0.9" />
          <circle cx="3.5" cy="2.2" r="1.3" fill="#07060c" />
        </>
      )}
    </svg>
  );
}

function Pill({
  name,
  color,
  text,
  size,
}: {
  name: string;
  color: string;
  text: string;
  size: number;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        background: color,
        color: text,
        borderRadius: 999,
        padding: `${size * 0.16}px ${size * 0.34}px`,
        font: `500 ${Math.max(9, size * 0.36)}px/1.1 var(--font-mono-stack, monospace)`,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
        userSelect: "none",
      }}
    >
      {name}
    </span>
  );
}

/** One agent cursor: wanders to random waypoints inside the section. */
function GhostCursor({
  agent,
  bounds,
  active,
  index,
}: {
  agent: Agent;
  bounds: { current: { w: number; h: number } };
  active: boolean;
  index: number;
}) {
  const x = useMotionValue(-9999);
  const y = useMotionValue(-9999);
  // Trails behind its own arrow, same as the user's pill.
  const px = useSpring(x, { stiffness: 190, damping: 24, mass: 0.7 });
  const py = useSpring(y, { stiffness: 190, damping: 24, mass: 0.7 });
  const vx = useVelocity(x);
  const tilt = useSpring(
    useTransform(vx, (v) => Math.max(-16, Math.min(16, v / 42))),
    { stiffness: 180, damping: 22 }
  );
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrlX: ReturnType<typeof animate> | undefined;
    let ctrlY: ReturnType<typeof animate> | undefined;

    // Keep clear of the section's top strip: the sticky header floats over it,
    // and a wandering pill colliding with the nav reads as a bug, not presence.
    const padX = 60;
    const padTop = 150;
    const padBottom = 90;
    const pick = () => {
      const { w, h } = bounds.current;
      return {
        nx: padX + Math.random() * Math.max(1, w - padX * 2),
        ny: padTop + Math.random() * Math.max(1, h - padTop - padBottom),
      };
    };

    // Start somewhere sensible, then walk.
    const seed = pick();
    x.set(seed.nx);
    y.set(seed.ny);
    setVisible(true);

    const step = () => {
      if (cancelled) return;
      const { nx, ny } = pick();
      const dist = Math.hypot(nx - x.get(), ny - y.get());
      // Human-ish: longer hops take longer, but never a crawl or a teleport.
      const duration = Math.min(3.2, Math.max(0.85, dist / 280));
      const ease = [0.33, 0, 0.25, 1] as const;
      ctrlX = animate(x, nx, { duration, ease });
      ctrlY = animate(y, ny, { duration, ease });
      ctrlY.then(() => {
        if (cancelled) return;
        timer = setTimeout(step, 260 + Math.random() * 1100);
      });
    };
    // Stagger so they don't all set off together.
    timer = setTimeout(step, index * 280 + Math.random() * 400);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ctrlX?.stop();
      ctrlY?.stop();
    };
  }, [active, bounds, index, x, y]);

  return (
    <>
      <motion.div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          x: px,
          y: py,
          rotate: tilt,
          transformOrigin: "0% 50%",
          translateX: 18,
          translateY: 14,
          opacity: visible ? 1 : 0,
          transition: "opacity 260ms ease",
        }}
      >
        <Pill name={agent.name} color={agent.color} text={agent.text} size={26} />
      </motion.div>
      <motion.div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          x,
          y,
          opacity: visible ? 1 : 0,
          transition: "opacity 260ms ease",
        }}
      >
        <Glyph size={26} color={agent.color} />
      </motion.div>
    </>
  );
}

export default function PresenceCursors({ label = "you" }: { label?: string }) {
  const reduced = useStaticMotion();
  const overlayRef = useRef<HTMLDivElement>(null);
  const bounds = useRef({ w: 1200, h: 900 });

  const [coarse, setCoarse] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [hovering, setHovering] = useState(false);

  const mx = useMotionValue(-9999);
  const my = useMotionValue(-9999);
  const ax = useSpring(mx, { stiffness: 420, damping: 34, mass: 0.5 });
  const ay = useSpring(my, { stiffness: 420, damping: 34, mass: 0.5 });
  const lx = useSpring(mx, { stiffness: 210, damping: 25, mass: 0.7 });
  const ly = useSpring(my, { stiffness: 210, damping: 25, mass: 0.7 });
  const vx = useVelocity(mx);
  const tilt = useSpring(
    useTransform(vx, (v) => Math.max(-22, Math.min(22, v / 38))),
    { stiffness: 200, damping: 24 }
  );
  const press = useMotionValue(1);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(pointer: coarse)");
    const sync = () => setCoarse(mql.matches);
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  const enabled = !reduced && !coarse;

  useEffect(() => {
    const overlay = overlayRef.current;
    // The section this overlay was dropped into is the pointer surface.
    const surface = overlay?.parentElement;
    if (!overlay || !surface || !enabled) return;

    const measure = () => {
      const r = surface.getBoundingClientRect();
      bounds.current = { w: r.width, h: r.height };
    };
    measure();

    const io = new IntersectionObserver(
      (entries) => setOnScreen(!!entries[0]?.isIntersecting),
      { rootMargin: "-10% 0px -10% 0px" }
    );
    io.observe(surface);

    const ro = new ResizeObserver(measure);
    ro.observe(surface);

    const onMove = (e: MouseEvent) => {
      const r = surface.getBoundingClientRect();
      mx.set(e.clientX - r.left);
      my.set(e.clientY - r.top);
    };
    const onEnter = () => setHovering(true);
    const onLeave = () => setHovering(false);
    const onDown = () => animate(press, 0.86, { duration: 0.12 });
    const onUp = () => animate(press, 1, { type: "spring", stiffness: 480, damping: 26 });

    surface.addEventListener("mousemove", onMove);
    surface.addEventListener("mouseenter", onEnter);
    surface.addEventListener("mouseleave", onLeave);
    surface.addEventListener("mousedown", onDown);
    surface.addEventListener("mouseup", onUp);

    return () => {
      io.disconnect();
      ro.disconnect();
      surface.removeEventListener("mousemove", onMove);
      surface.removeEventListener("mouseenter", onEnter);
      surface.removeEventListener("mouseleave", onLeave);
      surface.removeEventListener("mousedown", onDown);
      surface.removeEventListener("mouseup", onUp);
      surface.classList.remove("cursor-presence");
    };
  }, [enabled, mx, my, press]);

  // Hide the OS cursor only while it is actually in here and the section is in
  // view; scrolling away or leaving hands the normal cursor straight back.
  const takeover = enabled && onScreen && hovering;
  useEffect(() => {
    const surface = overlayRef.current?.parentElement;
    if (!surface) return;
    surface.classList.toggle("cursor-presence", takeover);
  }, [takeover]);

  if (!enabled) return null;

  return (
    <div
      ref={overlayRef}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
      {/* Agents wander whenever the section is on screen — they are working
          whether or not you are pointing at them. */}
      {onScreen &&
        AGENTS.map((a, i) => (
          <GhostCursor key={a.name} agent={a} bounds={bounds} active={onScreen} index={i} />
        ))}

      {/* Your own cursor, restyled while you are inside the section */}
      <motion.div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          x: lx,
          y: ly,
          rotate: tilt,
          scale: press,
          transformOrigin: "0% 50%",
          translateX: 22,
          translateY: 16,
          opacity: takeover ? 1 : 0,
          transition: "opacity 140ms ease",
        }}
      >
        <Pill name={label} color={YOU_COLOR} text="#12001f" size={30} />
      </motion.div>
      <motion.div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          x: ax,
          y: ay,
          scale: press,
          transformOrigin: "0% 0%",
          opacity: takeover ? 1 : 0,
          transition: "opacity 140ms ease",
        }}
      >
        <Glyph size={30} color={YOU_COLOR} you />
      </motion.div>
    </div>
  );
}
