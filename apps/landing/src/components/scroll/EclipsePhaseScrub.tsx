"use client";

import {
  motion,
  useMotionValue,

  useTransform,
} from "framer-motion";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";
import { EclipsePhase, PHASE_HUES } from "@/components/EclipseMark";
import { useSceneProgress } from "@/components/scroll/Scene";

/** End-state moon offset per phase — matches EclipseMark's PHASE_OFFSET. */
const PHASE_OFFSET = [11, 7, 3.5, 0];

/**
 * Scroll-driven eclipse-phase glyph: as the scene crosses the viewport the
 * moon slides in from off-disc and settles at this section's phase — the
 * scroll progress IS the eclipse progress (oryzo's --active-ratio pattern).
 * Falls back to the static glyph under reduced motion.
 */
export default function EclipsePhaseScrub({
  phase,
  size = 84,
}: {
  phase: 0 | 1 | 2 | 3;
  size?: number;
}) {
  const reduced = useStaticMotion();
  const scene = useSceneProgress();
  const settled = useMotionValue(1);
  const progress = reduced || !scene ? settled : scene;

  const target = PHASE_OFFSET[phase] ?? 0;
  const total = phase === 3;
  // Moon approaches from the right, settles at this phase's offset by mid-scene.
  const dx = useTransform(progress, [0.05, 0.5], [26, target], { clamp: true });
  const cx = useTransform(dx, (v) => 36 + v);
  const cy = useTransform(dx, (v) => 36 - v * 0.35);
  // Corona ring + flare only once the moon is nearly seated (totality section).
  const totalityOpacity = useTransform(dx, [target, target + 2], [1, 0]);

  if (reduced || !scene) {
    return <EclipsePhase phase={phase} size={size} />;
  }

  const id = `eps-p${phase}`;
  const [disc, glow] = PHASE_HUES[phase] ?? PHASE_HUES[0]!;
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden>
      <defs>
        <radialGradient id={`${id}-g`} cx="50%" cy="50%" r="50%">
          <stop offset="48%" stopColor={disc} stopOpacity={total ? 0.85 : 0.6} />
          <stop offset="72%" stopColor={glow} stopOpacity={total ? 0.42 : 0.26} />
          <stop offset="100%" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-d`} cx="42%" cy="38%" r="70%">
          <stop offset="0%" stopColor={disc} />
          <stop offset="100%" stopColor={glow} />
        </radialGradient>
        <clipPath id={`${id}-c`}>
          <circle cx="36" cy="36" r="21" />
        </clipPath>
      </defs>
      <circle cx="36" cy="36" r="34" fill={`url(#${id}-g)`} />
      <circle cx="36" cy="36" r="20" fill={`url(#${id}-d)`} />
      <circle cx="36" cy="36" r="20" stroke="#f4ecff" strokeWidth="0.8" opacity="0.7" />
      <g clipPath={`url(#${id}-c)`}>
        <motion.circle cx={cx} cy={cy} r="19.4" fill="#0b0713" />
      </g>
      {total && (
        <motion.g style={{ opacity: totalityOpacity }}>
          <circle cx="36" cy="36" r="20" stroke={disc} strokeWidth="1.8" />
          <circle cx="49.5" cy="23.5" r="1.9" fill="#ffffff" />
          <circle cx="49.5" cy="23.5" r="4" fill="#c4a8ff" opacity="0.28" />
        </motion.g>
      )}
    </svg>
  );
}
