"use client";

import Lenis from "lenis";
import { useReducedMotion } from "framer-motion";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const LenisContext = createContext<Lenis | null>(null);

/** Lenis instance for programmatic scrolls (header nav); null before init or under reduced motion. */
export function useLenis() {
  return useContext(LenisContext);
}

/**
 * Lusion-style lerped smooth scrolling. Native scroll stays the source of
 * truth (Lenis wraps window scroll), so framer-motion's useScroll keeps
 * working unchanged. Disabled entirely under prefers-reduced-motion.
 */
export default function SmoothScroll({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const [lenis, setLenis] = useState<Lenis | null>(null);

  useEffect(() => {
    if (reduced) return;
    const instance = new Lenis({ lerp: 0.12, wheelMultiplier: 1 });
    let raf = 0;
    const loop = (time: number) => {
      instance.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    setLenis(instance);
    return () => {
      cancelAnimationFrame(raf);
      instance.destroy();
      setLenis(null);
    };
  }, [reduced]);

  return <LenisContext.Provider value={lenis}>{children}</LenisContext.Provider>;
}
