"use client";

import Lenis from "lenis";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * The instance is shared through a ref rather than state: consumers only need it
 * inside event handlers (nav clicks), so publishing it via setState would cost a
 * re-render of the whole tree for something nothing renders.
 */
const LenisContext = createContext<RefObject<Lenis | null> | null>(null);

/** Ref to the Lenis instance — null before init and under reduced motion. */
export function useLenis() {
  return useContext(LenisContext);
}

/**
 * Lusion-style lerped smooth scrolling. Native scroll stays the source of truth
 * (Lenis wraps window scroll), so framer-motion's useScroll keeps working
 * unchanged. Disabled entirely under prefers-reduced-motion.
 */
export default function SmoothScroll({ children }: { children: ReactNode }) {
  const reduced = useStaticMotion();
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    if (reduced) return;
    const instance = new Lenis({ lerp: 0.12, wheelMultiplier: 1 });
    lenisRef.current = instance;
    let raf = 0;
    const loop = (time: number) => {
      instance.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      instance.destroy();
      lenisRef.current = null;
    };
  }, [reduced]);

  return <LenisContext.Provider value={lenisRef}>{children}</LenisContext.Provider>;
}
