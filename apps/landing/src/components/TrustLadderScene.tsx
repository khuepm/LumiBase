"use client";

import { useRef, useState } from "react";
import {
  motion,
  useMotionValueEvent,
  useScroll,
  useTransform,
} from "framer-motion";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * TrustLadderScene — the trust gradient told as a scroll beat, not a control panel.
 *
 * One idea per screen, in plain words, with the technical name kept small and to
 * the side. Scroll climbs the ladder one rung at a time; then an incident hits
 * and the light falls the whole way down inside a scroll band so narrow it reads
 * as instant however slowly you are scrolling. That asymmetry is the entire
 * point of the section, and it needs no buttons to land.
 */

const RUNGS = [
  {
    tag: "L0 · Shadow",
    head: "It only watches.",
    sub: "The agent runs, but its output is just recorded for review. Your content is never touched.",
  },
  {
    tag: "L1 · Propose",
    head: "It has to ask. Every time.",
    sub: "Every action becomes a request. Nothing moves until a person approves it.",
  },
  {
    tag: "L2 · Co-sign",
    head: "Safe work alone. Risky work with you.",
    sub: "Routine edits go ahead on their own; anything dangerous still waits for a human.",
  },
  {
    tag: "L3 · Veto window",
    head: "It goes ahead — you have four hours to object.",
    sub: "Silence is consent. The change waits in a draft and publishes itself unless someone objects. Most teams stay here.",
  },
  {
    tag: "L4 · Autopilot",
    head: "It acts on its own, inside a budget.",
    sub: "Earned over months of clean work. The stop button never goes away.",
  },
] as const;

const INCIDENT = {
  tag: "incident → automatic demotion",
  head: "Then something goes wrong.",
  sub: "Trust falls instantly — no approval, no meeting, no waiting. Earning it back starts from the bottom.",
};

/** Scroll positions where each beat takes over. */
const BEATS = [0, 0.24, 0.36, 0.48, 0.58, 0.7] as const;
/** The fall happens inside this band — kept tiny so it never feels gradual. */
const FALL_IN = 0.7;
const FALL_OUT = 0.715;

export default function TrustLadderScene() {
  const reduced = useStaticMotion();
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });

  const [beat, setBeat] = useState(0); // 0–4 rungs, 5 = incident
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    let next = 0;
    for (let i = 0; i < BEATS.length; i += 1) if (v >= BEATS[i]!) next = i;
    setBeat((b) => (b === next ? b : next));
  });

  const rowH = 62;
  // Climb rung by rung — each level holds for a beat before the next step, so the
  // ladder reads as five decisions rather than one continuous slide.
  const level = useTransform(
    scrollYProgress,
    [0.06, 0.2, 0.26, 0.32, 0.38, 0.44, 0.5, 0.56, FALL_IN, FALL_OUT],
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 0]
  );
  const tokenY = useTransform(level, (l) => (4 - l) * rowH);
  const fallen = useTransform(scrollYProgress, (v) => (v >= FALL_OUT ? 1 : 0));

  // Impact: a flash and a short shake, both confined to the fall band.
  const flash = useTransform(
    scrollYProgress,
    [FALL_IN, FALL_IN + 0.004, FALL_OUT + 0.02],
    [0, 0.55, 0]
  );
  const shake = useTransform(
    scrollYProgress,
    [FALL_IN, FALL_OUT, FALL_OUT + 0.004, FALL_OUT + 0.008, FALL_OUT + 0.014],
    [0, -10, 8, -4, 0]
  );

  const isIncident = beat >= 5;
  const copy = isIncident ? INCIDENT : RUNGS[beat]!;
  const accent = isIncident ? "#ff4d8d" : beat >= 3 ? "#ffb020" : "#29d8e6";

  // Reduced motion: the same content as a plain list, no scroll dependency.
  if (reduced) {
    return (
      <section className="relative mx-auto my-[8vh] max-w-[900px] px-5 py-14">
        <hr className="rule-dashed absolute inset-x-0 top-0" />
        <p className="label-mono m-0">[ 01B / EARNED AUTONOMY ]</p>
        <h2
          className="m-0 mt-3 uppercase"
          style={{ font: "800 34px/38px var(--font-sans, inherit)", letterSpacing: "-0.01em" }}
        >
          How much can it do on its own?
        </h2>
        <div className="mt-8 flex flex-col gap-6">
          {[...RUNGS, INCIDENT].map((r) => (
            <div key={r.tag}>
              <span className="label-mono">{r.tag}</span>
              <div
                className="mt-1"
                style={{ font: "600 19px/26px var(--font-sans, inherit)", color: "var(--foreground)" }}
              >
                {r.head}
              </div>
              <p
                className="font-serif-body mb-0 mt-1"
                style={{ font: "400 15px/25px var(--font-serif-stack)", color: "var(--color-text-secondary)" }}
              >
                {r.sub}
              </p>
            </div>
          ))}
        </div>
        <hr className="rule-dashed absolute inset-x-0 bottom-0" />
      </section>
    );
  }

  return (
    <section ref={ref} className="relative" style={{ height: "300vh" }}>
      <div className="sticky top-0 flex h-screen items-center overflow-hidden">
        {/* Impact flash */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ opacity: flash, background: "#ff4d8d", mixBlendMode: "screen" }}
        />

        <div className="mx-auto grid w-full max-w-[1100px] grid-cols-1 items-center gap-10 px-5 md:grid-cols-[1.1fr_0.9fr]">
          {/* ── The sentence ──────────────────────────────────────── */}
          <div>
            <p className="label-mono m-0">[ 01B / EARNED AUTONOMY ]</p>

            <motion.div
              key={copy.head}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <h2
                className="m-0 mt-4 uppercase [font:800_30px/34px_var(--font-sans)] md:[font:800_42px/46px_var(--font-sans)]"
                style={{
                  letterSpacing: "-0.01em",
                  color: isIncident ? "#ff9ec0" : "var(--foreground)",
                }}
              >
                {copy.head}
              </h2>
              <p
                className="font-serif-body mt-4 max-w-[440px]"
                style={{
                  font: "400 18px/29px var(--font-serif-stack)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {copy.sub}
              </p>
              <p className="label-mono mt-5" style={{ color: accent }}>
                {copy.tag}
              </p>
            </motion.div>
          </div>

          {/* ── The ladder ────────────────────────────────────────── */}
          <motion.div className="relative mx-auto" style={{ x: shake, width: 260, height: rowH * 5 }}>
            {RUNGS.map((r, i) => {
              const idx = 4 - i; // top row is L4
              return (
                <div
                  key={r.tag}
                  className="absolute inset-x-0 flex items-center gap-4"
                  style={{ top: i * rowH, height: rowH }}
                >
                  <span
                    className="label-mono w-6 shrink-0"
                    style={{ opacity: beat === idx && !isIncident ? 1 : 0.4 }}
                  >
                    L{idx}
                  </span>
                  <span
                    className="h-px flex-1"
                    style={{
                      background:
                        beat === idx && !isIncident
                          ? accent
                          : "var(--color-border)",
                      boxShadow: beat === idx && !isIncident ? `0 0 12px ${accent}` : "none",
                    }}
                  />
                </div>
              );
            })}

            {/* The light that climbs, then falls */}
            <motion.div
              className="absolute left-8 rounded-full"
              style={{
                y: tokenY,
                top: rowH / 2 - 7,
                width: 14,
                height: 14,
                background: isIncident ? "#ff4d8d" : accent,
                boxShadow: `0 0 18px ${isIncident ? "#ff4d8d" : accent}, 0 0 44px ${
                  isIncident ? "#ff4d8daa" : `${accent}aa`
                }`,
              }}
            />

            {/* Everything it lost, struck through */}
            <motion.div
              aria-hidden
              className="absolute inset-x-0"
              style={{
                opacity: fallen,
                top: 0,
                height: rowH * 4,
                background:
                  "repeating-linear-gradient(135deg, rgba(255,77,141,0.12) 0 6px, transparent 6px 12px)",
              }}
            />
          </motion.div>
        </div>

        {/* Closing line, only once the fall has happened. Sits clear of the
            eclipse stage's own fixed caption at the bottom of the viewport. */}
        <motion.p
          className="label-mono absolute inset-x-0 bottom-24 text-center"
          style={{ opacity: fallen, letterSpacing: "0.18em" }}
        >
          CLIMBING TAKES WEEKS OF CLEAN WORK · FALLING TAKES ONE INCIDENT
        </motion.p>
      </div>
    </section>
  );
}
