"use client";


import {
  motion,
  useMotionValueEvent,

  useScroll,
  useSpring,
  useTransform,
} from "framer-motion";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";
import { useState } from "react";

/**
 * The fixed eclipse stage behind the whole page — the scroll IS the eclipse.
 *
 * Page-progress choreography (oryzo's fixed-canvas + scroll-ratio pattern,
 * rebuilt with framer-motion instead of THREE/GSAP):
 *   0.00–0.10  hero — totality full-size centre, spaceship transit (scrubbed)
 *   0.10–0.24  stage shrinks and drifts to the top-right; moon slides off —
 *              light returns while the product sections play
 *   0.24–0.78  small partial-eclipse sun rides above the sections
 *   0.78–0.95  stage returns to centre, moon re-covers the sun — second
 *              totality over the final CTA, spaceship transits again
 */

function CoronaRays() {
  const rays = Array.from({ length: 14 }, (_, i) => {
    const angle = (360 / 14) * i;
    const len = i % 3 === 0 ? 300 : i % 2 === 0 ? 250 : 210;
    return { angle, len };
  });
  return (
    <svg
      className="eclipse-corona-rays absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      width={640}
      height={640}
      viewBox="0 0 640 640"
      fill="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="stage-ray" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ff8c00" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#e6500a" stopOpacity="0" />
        </linearGradient>
      </defs>
      {rays.map((r) => (
        <rect
          key={r.angle}
          x={150}
          y={318}
          width={r.len}
          height={4}
          rx={2}
          fill="url(#stage-ray)"
          transform={`rotate(${r.angle} 320 320)`}
        />
      ))}
    </svg>
  );
}

function TinyShip() {
  return (
    <svg width={44} height={26} viewBox="0 0 44 26" fill="none" aria-hidden>
      <path d="M12 13 H1" stroke="#ffedd7" strokeWidth="1.1" strokeLinecap="round" opacity="0.45" />
      <path d="M12 13 H6" stroke="#ffa000" strokeWidth="1.8" strokeLinecap="round" opacity="0.9" />
      <path
        d="M42 13 C 39.5 8.6 32.5 7.9 23 9.2 L 18 13 L 23 16.8 C 32.5 18.1 39.5 17.4 42 13 Z"
        fill="#ffedd7"
      />
      <path d="M26 9.6 L 21 5.6 L 19 11 Z" fill="#f6e0c6" />
      <path d="M26 16.4 L 21 20.4 L 19 15 Z" fill="#f6e0c6" />
      <circle cx="33" cy="13" r="1.8" fill="#100904" />
      <circle cx="28" cy="13" r="1.4" fill="#100904" opacity="0.75" />
    </svg>
  );
}

const DEFAULT_CAPTION = "FIG. 01 — TOTALITY, SPACECRAFT IN TRANSIT  [ NOT TO SCALE ]";
const CAPTIONS = [
  [0.0, DEFAULT_CAPTION],
  [0.1, "FIG. 02 — THIRD CONTACT · AI HARNESS ONLINE"],
  [0.26, "FIG. 03 — LIGHT RETURNS · CONTENT OS RECONCILING"],
  [0.44, "FIG. 04 — PARTIAL PHASE · STUDIO SUPERVISING"],
  [0.6, "FIG. 05 — ANNULAR DRIFT · RUNTIME AT THE EDGE"],
  [0.78, "FIG. 06 — SECOND CONTACT · FINAL TRANSMISSION"],
] as ReadonlyArray<readonly [number, string]>;

/** Static totality (reduced-motion fallback) — the pre-cinema hero scene. */
function StaticStage() {
  return (
    <div className="eclipse-stage">
      <CoronaRays />
      <div
        className="eclipse-corona absolute left-1/2 top-1/2 h-[460px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(255,160,0,0.55) 34%, rgba(230,80,10,0.3) 52%, rgba(230,80,10,0) 72%)",
        }}
      />
      <div
        className="absolute left-1/2 top-1/2 h-[268px] w-[268px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          boxShadow:
            "0 0 0 2.5px rgba(255,160,0,0.95), 0 0 0 3.5px rgba(255,237,215,0.5), var(--glow-corona)",
        }}
      />
      <div
        className="absolute left-1/2 top-1/2 h-[264px] w-[264px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 36% 32%, #2c1c0e 0%, #150c05 55%, #100904 100%)",
        }}
      />
      <div className="eclipse-ship absolute left-1/2 top-1/2 -ml-[22px] -mt-[13px]">
        <TinyShip />
      </div>
    </div>
  );
}

export default function EclipseStage() {
  const reduced = useStaticMotion();
  const { scrollYProgress } = useScroll();
  // Soften the scrub a touch — Lusion-style lag.
  const p = useSpring(scrollYProgress, { stiffness: 90, damping: 24, mass: 0.4 });

  // Stage cluster: full-size centre → small top-right → back to centre.
  const scale = useTransform(p, [0, 0.1, 0.2, 0.78, 0.92], [1, 0.85, 0.36, 0.36, 0.9]);
  const x = useTransform(p, [0, 0.1, 0.2, 0.78, 0.92], ["0vw", "8vw", "34vw", "34vw", "0vw"]);
  const y = useTransform(p, [0, 0.1, 0.2, 0.78, 0.92], ["24vh", "0vh", "-30vh", "-30vh", "0vh"]);

  // Moon offset (px at stage scale): 0 = totality. Slides off during the
  // sections, returns for the finale.
  const moonX = useTransform(p, [0, 0.12, 0.3, 0.72, 0.9], [0, 30, 195, 195, 0]);
  const moonY = useTransform(moonX, (v) => -v * 0.3);

  // Totality factor: 1 when the moon is seated, 0 when the sun is open.
  const totality = useTransform(moonX, [0, 70], [1, 0]);
  const sunOpacity = useTransform(totality, [0, 1], [1, 0]);

  // Two scrubbed ship transits: hero and finale.
  const ship1X = useTransform(p, [0.015, 0.1], [-360, 360]);
  const ship1Y = useTransform(p, [0.015, 0.1], [130, -130]);
  const ship1Opacity = useTransform(p, [0.015, 0.03, 0.085, 0.1], [0, 1, 1, 0]);
  const ship2X = useTransform(p, [0.84, 0.96], [-360, 360]);
  const ship2Y = useTransform(p, [0.84, 0.96], [130, -130]);
  const ship2Opacity = useTransform(p, [0.84, 0.87, 0.93, 0.96], [0, 1, 1, 0]);

  const [caption, setCaption] = useState<string>(DEFAULT_CAPTION);
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    let next = DEFAULT_CAPTION;
    for (const [at, text] of CAPTIONS) if (v >= at) next = text;
    setCaption((prev) => (prev === next ? prev : next));
  });

  if (reduced) {
    // Static backdrop: dimmed and shrunk so it never fights the content.
    return (
      <div className="eclipse-fixed-stage" aria-hidden>
        <div style={{ opacity: 0.3, transform: "scale(0.7)" }}>
          <StaticStage />
        </div>
      </div>
    );
  }

  return (
    <div className="eclipse-fixed-stage" aria-hidden>
      <div className="eclipse-stage-scaler">
      <motion.div
        className="absolute left-1/2 top-1/2 h-[640px] w-[640px] -ml-[320px] -mt-[320px]"
        style={{ scale, x, y, willChange: "transform" }}
      >
        {/* Corona rays + breathing glow — totality only */}
        <motion.div style={{ opacity: totality }}>
          <CoronaRays />
          <div
            className="eclipse-corona absolute left-1/2 top-1/2 h-[460px] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(255,160,0,0.55) 34%, rgba(230,80,10,0.3) 52%, rgba(230,80,10,0) 72%)",
            }}
          />
        </motion.div>

        {/* Open sun — visible while the moon is away */}
        <motion.div
          className="absolute left-1/2 top-1/2 h-[264px] w-[264px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            opacity: sunOpacity,
            background:
              "radial-gradient(circle at 42% 38%, #ffbf02 0%, #ffa000 55%, #e6500a 100%)",
            boxShadow: "0 0 90px rgba(255,160,0,0.45), 0 0 200px rgba(230,80,10,0.25)",
          }}
        />

        {/* Chromosphere ring — totality only */}
        <motion.div
          className="absolute left-1/2 top-1/2 h-[268px] w-[268px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            opacity: totality,
            boxShadow:
              "0 0 0 2.5px rgba(255,160,0,0.95), 0 0 0 3.5px rgba(255,237,215,0.5), var(--glow-corona)",
          }}
        />

        {/* The moon — scroll slides it across the sun */}
        <motion.div
          className="absolute left-1/2 top-1/2 h-[264px] w-[264px] -ml-[132px] -mt-[132px] rounded-full"
          style={{
            x: moonX,
            y: moonY,
            background:
              "radial-gradient(circle at 36% 32%, #2c1c0e 0%, #150c05 55%, #100904 100%)",
            boxShadow: "0 0 40px rgba(0,0,0,0.8)",
            willChange: "transform",
          }}
        />

        {/* Diamond-ring flare — blinks in right at totality */}
        <motion.div
          className="absolute rounded-full"
          style={{
            opacity: totality,
            left: "calc(50% + 88px)",
            top: "calc(50% - 102px)",
            width: 10,
            height: 10,
            background: "#ffedd7",
            boxShadow:
              "0 0 14px 5px rgba(255,237,215,0.75), 0 0 44px 16px rgba(255,160,0,0.4)",
          }}
        />

        {/* Scrubbed spaceship transits — hero and finale */}
        <motion.div
          className="absolute left-1/2 top-1/2 -ml-[22px] -mt-[13px]"
          style={{ x: ship1X, y: ship1Y, opacity: ship1Opacity, rotate: -12 }}
        >
          <TinyShip />
        </motion.div>
        <motion.div
          className="absolute left-1/2 top-1/2 -ml-[22px] -mt-[13px]"
          style={{ x: ship2X, y: ship2Y, opacity: ship2Opacity, rotate: -12 }}
        >
          <TinyShip />
        </motion.div>
      </motion.div>
      </div>

      {/* Observation caption — swaps per scene */}
      <div
        className="label-mono absolute bottom-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap sm:block"
        style={{ letterSpacing: "0.18em" }}
      >
        {caption}
      </div>
    </div>
  );
}
