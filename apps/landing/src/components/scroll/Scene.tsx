"use client";

import {
  motion,
  useMotionValue,
  useScroll,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { createContext, useContext, useRef, type ReactNode } from "react";

const SceneContext = createContext<MotionValue<number> | null>(null);

/**
 * Scroll progress of the enclosing <Scene> (0 → 1 as it crosses the
 * viewport) — the oryzo `--active-ratio` idea. Null outside a Scene.
 */
export function useSceneProgress() {
  return useContext(SceneContext);
}

/**
 * A scroll scene: tracks its own progress through the viewport and hands it
 * to children (WipeTitle, EclipsePhaseScrub, ParallaxItem). Layout is left
 * to the children — the wrapper itself stays in normal flow.
 */
export default function Scene({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.9", "end 0.6"],
  });

  return (
    <section id={id} ref={ref} className={className}>
      <SceneContext.Provider value={scrollYProgress}>
        {children}
      </SceneContext.Provider>
    </section>
  );
}

/** Card that drifts at its own rate while the scene scrolls — column offsets. */
export function ParallaxItem({
  children,
  className,
  drift = 0,
}: {
  children: ReactNode;
  className?: string;
  drift?: number;
}) {
  const progress = useSceneProgress();
  const fallback = useMotionValue(0.5);
  const y = useTransform(progress ?? fallback, [0, 1], [drift, -drift]);

  return (
    <motion.div className={className} style={drift ? { y } : undefined}>
      {children}
    </motion.div>
  );
}
