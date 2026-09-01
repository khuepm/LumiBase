"use client";

import {
  motion,
  useMotionValue,

  useTransform,
} from "framer-motion";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";
import type { ReactNode } from "react";
import { useSceneProgress } from "@/components/scroll/Scene";

/**
 * Editorial scene header, scrubbed by scroll — the oryzo wipe transition:
 * a dashed rule draws across, the mono label fades in, and the display
 * title reveals through a clip-path wipe as the scene enters the viewport.
 */
export default function WipeTitle({
  label,
  title,
  children,
}: {
  label: ReactNode;
  title: ReactNode;
  /** Optional block (tagline, CTA) that floats up after the title lands. */
  children?: ReactNode;
}) {
  const reduced = useStaticMotion();
  const scene = useSceneProgress();
  const staticOne = useMotionValue(1);
  const progress = reduced || !scene ? staticOne : scene;

  // Choreography inside the scene's first half: rule → label → title → rest.
  const rule = useTransform(progress, [0, 0.18], [0, 1]);
  const labelOpacity = useTransform(progress, [0.06, 0.2], [0, 1]);
  const clip = useTransform(
    progress,
    [0.12, 0.4],
    ["inset(0 100% 0 0)", "inset(0 0% 0 0)"]
  );
  const restOpacity = useTransform(progress, [0.3, 0.5], [0, 1]);
  const restY = useTransform(progress, [0.3, 0.5], [28, 0]);

  return (
    <div className="flex flex-col items-center text-center">
      <motion.hr
        className="rule-dashed mb-10 w-full"
        style={{ scaleX: rule, transformOrigin: "left center" }}
      />
      <motion.p className="label-mono m-0" style={{ opacity: labelOpacity }}>
        {label}
      </motion.p>
      <motion.h2
        className="m-0 mt-3 uppercase [font:800_34px/38px_var(--font-sans)] md:[font:800_48px/50px_var(--font-sans)]"
        style={{
          letterSpacing: "-0.01em",
          color: "var(--foreground)",
          clipPath: clip,
        }}
      >
        {title}
      </motion.h2>
      {children && (
        <motion.div
          className="flex flex-col items-center"
          style={{ opacity: restOpacity, y: restY }}
        >
          {children}
        </motion.div>
      )}
    </div>
  );
}
