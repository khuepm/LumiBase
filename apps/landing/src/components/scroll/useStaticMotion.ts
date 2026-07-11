"use client";

import { useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

/**
 * prefers-reduced-motion, hydration-safe: always false on the server AND the
 * first client render, flipping to the real value after mount. Branching on
 * useReducedMotion() directly would render a different tree during hydration
 * (React #418) since the server cannot know the media query.
 */
export function useStaticMotion() {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && !!reduced;
}
