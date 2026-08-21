"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import GlassGem, { SHARD_COUNT } from "@/components/GlassGem";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * IntentStage — the Content OS hero.
 *
 * The crystal is the intent: one declared desired state, cut and hashed, sitting
 * at the centre. Every shard around it is one content item in the collection the
 * intent governs. An item that satisfies its SLO is held close and lit by the
 * intent; an item that has drifted out is pushed outward, goes amber, and dims.
 * Reconciliation pulls it back.
 *
 * That mapping is the point. A static mock of a single rule says nothing about
 * content — you have to see a whole collection move against a rule, and see the
 * rule change underneath it, before "declare the state, the system converges"
 * means anything.
 */

interface Violation {
  /** A real item path — this is the content the intent is talking about. */
  item: string;
  /** Why it fails, in the words the incident would actually use. */
  reason: string;
  /** What the agent did about it, within the write budget. */
  fix: string;
}

interface Intent {
  collection: string;
  rule: string;
  total: number;
  violations: Violation[];
}

const INTENTS: Intent[] = [
  {
    collection: "products",
    rule: "≥ 1 image · 50–200 words · vi + en",
    total: 1284,
    violations: [
      {
        item: "products/ao-thun-basic-cotton",
        reason: "en translation missing",
        fix: "translator drafted en · queued for review",
      },
      {
        item: "products/ban-phim-co-k3",
        reason: "description 32 words, floor is 50",
        fix: "writer expanded to 96 words",
      },
      {
        item: "products/tai-nghe-air-2",
        reason: "no image on variant #3",
        fix: "held — no asset in library, escalated",
      },
    ],
  },
  {
    collection: "articles",
    rule: "reading time ≤ 6 min · 1 hero image · SEO title ≤ 60 chars",
    total: 412,
    violations: [
      {
        item: "articles/edge-caching-explained",
        reason: "SEO title 68 chars",
        fix: "seo agent rewrote to 54 chars",
      },
      {
        item: "articles/multi-tenant-rls-deep-dive",
        reason: "reading time 11 min",
        fix: "split into a 2-part series",
      },
    ],
  },
  {
    collection: "docs",
    rule: "en/vi parity · no dead links · code samples compile",
    total: 2160,
    violations: [
      {
        item: "docs/vi/operations/upgrades",
        reason: "parity drift — en revised, vi stale",
        fix: "re-translated against the new source hash",
      },
      {
        item: "docs/en/api/hono-api-spec",
        reason: "3 links resolve 404",
        fix: "repointed at the moved routes",
      },
      {
        item: "docs/en/ai-skills",
        reason: "sample fails typecheck",
        fix: "held — needs a human, opened an issue",
      },
    ],
  },
  {
    collection: "landing",
    rule: "alt text on every image · contrast ≥ 4.5:1",
    total: 96,
    violations: [
      {
        item: "landing/pricing/hero.png",
        reason: "alt text empty",
        fix: "described from the image",
      },
    ],
  },
];

/** The loop, in beats. Each entry is how long that beat holds, in ms. */
const BEATS = [
  { phase: "declare", ms: 1500 },
  { phase: "evaluate", ms: 2100 },
  { phase: "incident", ms: 3200 },
  { phase: "reconcile", ms: 3400 },
  { phase: "converged", ms: 2200 },
] as const;

type Phase = (typeof BEATS)[number]["phase"];

/**
 * Which shards stand for the violating items. Fixed slots rather than random
 * ones, so the same shard drifts every cycle and the eye can follow it — a
 * different shard each time reads as noise, not as a control loop.
 */
const VIOLATOR_SLOTS = [4, 17, 29, 41, 53, 61];

const PHASE_LABEL: Record<Phase, string> = {
  declare: "intent declared",
  evaluate: "evaluating collection",
  incident: "slo violated",
  reconcile: "reconciling",
  converged: "converged",
};

export default function IntentStage() {
  const reduced = useStaticMotion();
  const [step, setStep] = useState(0);
  // Written every frame by the beat machine, read every frame by the WebGL
  // field. Deliberately outside React: this changes far too often to be state.
  const targets = useRef<Float32Array>(new Float32Array(SHARD_COUNT).fill(1));

  const intent = INTENTS[Math.floor(step / BEATS.length) % INTENTS.length]!;
  const phase: Phase = reduced ? "incident" : BEATS[step % BEATS.length]!.phase;
  const failing = intent.violations.length;

  useEffect(() => {
    if (reduced) return;
    const hold = BEATS[step % BEATS.length]!.ms;
    const id = setTimeout(() => setStep((s) => s + 1), hold);
    return () => clearTimeout(id);
  }, [step, reduced]);

  // Drive the field from the beat. Everything converged except, during the two
  // beats where it matters, the slots standing in for the failing items.
  useEffect(() => {
    const arr = targets.current;
    const drifting = phase === "incident" || phase === "evaluate";
    arr.fill(1);
    if (drifting) {
      for (let i = 0; i < failing; i++) {
        const slot = VIOLATOR_SLOTS[i % VIOLATOR_SLOTS.length]!;
        arr[slot] = 0;
        // A neighbour partly out too, so the drift reads as a region of the
        // collection rather than a single blinking dot.
        arr[(slot + 7) % SHARD_COUNT] = 0.45;
      }
    }
  }, [phase, failing]);

  const converged =
    phase === "incident" || phase === "evaluate" ? intent.total - failing : intent.total;

  return (
    <div className="relative left-1/2 w-screen -translate-x-1/2 overflow-hidden">
      <div className="rule-dashed" />
      <div className="relative h-[520px] md:h-[620px]">
        <GlassGem targets={targets} gemScale={1.35} />

        {/* Scrims. The crystal is deliberately large enough to sit under the
            copy, and its brightness swings as it turns, so legibility cannot be
            left to luck — these guarantee contrast at both ends whatever the
            animation is doing underneath. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[34%]"
          style={{ background: "linear-gradient(180deg, rgba(7,6,12,0.94), rgba(7,6,12,0))" }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%]"
          style={{ background: "linear-gradient(0deg, rgba(7,6,12,0.95), rgba(7,6,12,0))" }}
        />

        {/* Everything below is DOM on top of the canvas: the canvas shows the
            collection moving, the text says what the collection *is*. */}
        {/* Everything that names the intent lives under ONE AnimatePresence,
            keyed by the collection, with the per-beat animation nested inside
            it. Two sibling presences cannot be kept in step: `mode="wait"` holds
            each outgoing child until its own exit finishes, so one flips to the
            next intent while the other is still showing the last one, and you
            get a header naming one collection over another one's item paths.
            Nesting makes that state unrepresentable rather than unlikely. */}
        <AnimatePresence mode="wait">
        <motion.div
          key={intent.collection}
          initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
          transition={{ duration: 0.22 }}
          className="pointer-events-none absolute inset-0 flex flex-col justify-between px-5 py-8 md:px-10 md:py-12"
        >
          <div className="mx-auto w-full max-w-[860px] text-center">
            <div className="label-mono" style={{ color: "var(--color-text-muted)" }}>
              [ INTENT · {intent.collection} ·{" "}
              {intent.total.toLocaleString("en-US")} items ]
            </div>
            <p
              className="font-serif-body mx-auto mt-3 max-w-[680px]"
              style={{
                font: "400 clamp(20px, 3vw, 30px)/1.35 var(--font-serif-stack)",
                color: "var(--foreground)",
              }}
            >
              {intent.rule}
            </p>
          </div>

          <div className="mx-auto w-full max-w-[860px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={phase}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22 }}
                className="min-h-[92px]"
              >
                <div
                  className="label-mono mb-2.5 flex items-center justify-center gap-2"
                  style={{
                    color:
                      phase === "incident"
                        ? "var(--hue-gold)"
                        : "var(--color-text-muted)",
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background:
                        phase === "incident" ? "var(--hue-gold)" : "var(--hue-teal)",
                      boxShadow: `0 0 8px ${
                        phase === "incident" ? "var(--hue-gold)" : "var(--hue-teal)"
                      }`,
                    }}
                  />
                  {PHASE_LABEL[phase]}
                </div>

                <ul className="mx-auto flex max-w-[720px] flex-col gap-1.5">
                  {intent.violations.map((v) => (
                    <li
                      key={v.item}
                      className="card-cosmic flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-2 text-center"
                    >
                      <code
                        style={{
                          font: "500 12px var(--font-mono-stack)",
                          color: "var(--foreground)",
                        }}
                      >
                        {v.item}
                      </code>
                      <span
                        style={{
                          font: "400 12px var(--font-mono-stack)",
                          color:
                            phase === "reconcile" || phase === "converged"
                              ? "var(--hue-teal)"
                              : "var(--hue-gold)",
                        }}
                      >
                        {phase === "reconcile" || phase === "converged"
                          ? `✓ ${v.fix}`
                          : `✕ ${v.reason}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            </AnimatePresence>

            <div className="mt-4 flex items-center justify-center gap-3">
              <span
                className="label-mono"
                style={{ color: "var(--color-text-muted)" }}
              >
                converged
              </span>
              <div
                className="relative h-1 w-[180px] overflow-hidden rounded-full"
                style={{ background: "var(--color-surface-4)" }}
              >
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ background: "var(--hue-teal)" }}
                  animate={{ width: `${(converged / intent.total) * 100}%` }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                />
              </div>
              <span
                className="label-mono"
                style={{ color: "var(--foreground)" }}
              >
                {converged.toLocaleString("en-US")} / {intent.total.toLocaleString("en-US")}
              </span>
            </div>
          </div>
        </motion.div>
        </AnimatePresence>
      </div>
      <div className="rule-dashed" />
    </div>
  );
}
