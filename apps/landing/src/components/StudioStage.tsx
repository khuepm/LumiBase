"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import GlassGem, { SHARD_COUNT } from "@/components/GlassGem";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * StudioStage — the Studio lead.
 *
 * The crystal is the console: the one point every agent change passes through
 * before it ships. Each shard around it is a change in flight. A change that is
 * clear stays close and lit; one that needs a human is pushed out and goes
 * amber; and when the kill switch throws, the whole field goes dark at once.
 *
 * Three scenes, because supervising is three different jobs — reviewing the
 * exceptions, letting the veto window run, and stopping everything. The copy
 * leads in plain language and keeps the LumiBase term as the annotation, not
 * the other way round.
 */

interface Row {
  /** What changed — a real path, so the queue reads as work and not as chrome. */
  item: string;
  /** Who proposed it and why it is here. */
  meta: string;
  /** State while the human has not acted yet. */
  pending: string;
  /** State after. */
  done: string;
}

type Mode = "review" | "veto" | "halt";

interface Scene {
  mode: Mode;
  label: string;
  headline: string;
  /** Plain-language first; the LumiBase term rides along as annotation. */
  term: string;
  rows: Row[];
  meter: { label: string; of: number; pending: number };
}

const SCENES: Scene[] = [
  {
    mode: "review",
    label: "[ ON DUTY · 1 human · 12 agents ]",
    headline: "You review the exceptions, not the 1,284 items.",
    term: "exception inbox",
    rows: [
      {
        item: "products/ban-phim-co-k3",
        meta: "writer · rewrote price copy",
        pending: "waiting on you",
        done: "approved",
      },
      {
        item: "docs/en/security/user-management",
        meta: "translator · touched an auth doc",
        pending: "waiting on you",
        done: "approved · vi queued",
      },
      {
        item: "collections/orders — schema",
        meta: "architect · drops a field",
        pending: "waiting on you",
        done: "rejected · field kept",
      },
    ],
    meter: { label: "cleared without you", of: 47, pending: 44 },
  },
  {
    mode: "veto",
    label: "[ AUTONOMY L3 · 10 MIN BUDGET ]",
    headline: "Staged, not shipped. Say nothing and it commits.",
    term: "veto window",
    rows: [
      {
        item: "products/* — bulk retitle",
        meta: "seo · 212 items",
        pending: "commits in 6:12",
        done: "committed",
      },
      {
        item: "articles/edge-caching-explained",
        meta: "editor · rewrote the lede",
        pending: "commits in 2:48",
        done: "committed",
      },
      {
        item: "landing/pricing — plan copy",
        meta: "writer · changes a price",
        pending: "commits in 0:31",
        done: "vetoed by you",
      },
    ],
    meter: { label: "committed unopposed", of: 47, pending: 46 },
  },
  {
    mode: "halt",
    label: "[ KILL SWITCH · 4 SCOPES ]",
    headline: "One switch stops every agent, at any autonomy level.",
    term: "four-scope halt",
    rows: [
      { item: "scope: tenant", meta: "all sites", pending: "armed", done: "halted" },
      { item: "scope: collection", meta: "products, orders", pending: "armed", done: "halted" },
      { item: "scope: skill", meta: "schema:write", pending: "armed", done: "halted" },
      { item: "scope: agent", meta: "seo-agent-03", pending: "armed", done: "halted" },
    ],
    meter: { label: "agents stopped", of: 12, pending: 0 },
  },
];

const BEATS = [
  { phase: "incoming", ms: 1600 },
  { phase: "pending", ms: 3000 },
  { phase: "acting", ms: 2400 },
  { phase: "settled", ms: 2400 },
] as const;

type Phase = (typeof BEATS)[number]["phase"];

/**
 * Fixed slots for the changes that need a human, so the same shards drift every
 * cycle and the eye can follow them. Different shards each time reads as noise.
 */
const FLAGGED_SLOTS = [6, 19, 33, 47];

const PHASE_LABEL: Record<Mode, Record<Phase, string>> = {
  review: {
    incoming: "12 agents working",
    pending: "3 need a human",
    acting: "you decide",
    settled: "cleared",
  },
  veto: {
    incoming: "staged for commit",
    pending: "veto window open",
    acting: "one vetoed",
    settled: "window closed",
  },
  halt: {
    incoming: "agents running",
    pending: "switch armed",
    acting: "halting",
    settled: "all stopped",
  },
};

export default function StudioStage() {
  const reduced = useStaticMotion();
  const [step, setStep] = useState(0);
  // Read every frame by the WebGL field, written on every beat. Kept out of
  // React because it changes far too often to be state.
  const targets = useRef<Float32Array>(new Float32Array(SHARD_COUNT).fill(1));

  const scene = SCENES[Math.floor(step / BEATS.length) % SCENES.length]!;
  const phase: Phase = reduced ? "pending" : BEATS[step % BEATS.length]!.phase;
  const acted = phase === "acting" || phase === "settled";

  useEffect(() => {
    if (reduced) return;
    const id = setTimeout(() => setStep((s) => s + 1), BEATS[step % BEATS.length]!.ms);
    return () => clearTimeout(id);
  }, [step, reduced]);

  // The field is the queue. Flagged changes are pushed out of the console's
  // reach; a halt takes the entire field dark, which is the only beat where
  // every shard moves at once — and that is the point of a kill switch.
  useEffect(() => {
    const arr = targets.current;
    const halting = scene.mode === "halt" && (phase === "acting" || phase === "settled");
    if (halting) {
      arr.fill(0.08);
      return;
    }
    arr.fill(1);
    if (phase === "pending" || phase === "acting") {
      const held = phase === "acting" ? 0.55 : 0;
      for (let i = 0; i < scene.rows.length; i++) {
        arr[FLAGGED_SLOTS[i % FLAGGED_SLOTS.length]!] = held;
        arr[(FLAGGED_SLOTS[i % FLAGGED_SLOTS.length]! + 9) % SHARD_COUNT] = held + 0.3;
      }
    }
  }, [phase, scene]);

  const value = acted ? scene.meter.of : scene.meter.pending;
  const alarm = scene.mode === "halt" ? acted : phase === "pending";

  return (
    <div className="relative left-1/2 w-screen -translate-x-1/2 overflow-hidden">
      <div className="rule-dashed" />
      <div className="relative h-[520px] md:h-[620px]">
        <GlassGem targets={targets} gemScale={1.35} />

        {/* The crystal is deliberately large enough to sit under the copy and
            its brightness swings as it turns, so contrast cannot be left to the
            animation — these guarantee it at both ends. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[34%]"
          style={{ background: "linear-gradient(180deg, rgba(7,6,12,0.94), rgba(7,6,12,0))" }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%]"
          style={{ background: "linear-gradient(0deg, rgba(7,6,12,0.95), rgba(7,6,12,0))" }}
        />

        {/* One AnimatePresence for the scene, with the per-beat one nested
            inside it. Two siblings cannot be kept in step: mode="wait" holds
            each outgoing child until its own exit ends, so one would flip to the
            next scene while the other still showed the last. */}
        <AnimatePresence mode="wait">
          <motion.div
            key={scene.mode}
            initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
            transition={{ duration: 0.22 }}
            className="pointer-events-none absolute inset-0 flex flex-col justify-between px-5 py-8 md:px-10 md:py-12"
          >
            <div className="mx-auto w-full max-w-[860px] text-center">
              <div className="label-mono" style={{ color: "var(--color-text-muted)" }}>
                {scene.label}
              </div>
              <p
                className="font-serif-body mx-auto mt-3 max-w-[660px]"
                style={{
                  font: "400 clamp(20px, 3vw, 30px)/1.35 var(--font-serif-stack)",
                  color: "var(--foreground)",
                }}
              >
                {scene.headline}
              </p>
              <div
                className="label-mono mt-2"
                style={{ color: "var(--color-text-muted)", opacity: 0.75 }}
              >
                {scene.term}
              </div>
            </div>

            <div className="mx-auto w-full max-w-[860px]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={phase}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  className="min-h-[104px]"
                >
                  <div
                    className="label-mono mb-2.5 flex items-center justify-center gap-2"
                    style={{
                      color: alarm ? "var(--hue-gold)" : "var(--color-text-muted)",
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{
                        background: alarm ? "var(--hue-gold)" : "var(--hue-teal)",
                        boxShadow: `0 0 8px ${alarm ? "var(--hue-gold)" : "var(--hue-teal)"}`,
                      }}
                    />
                    {PHASE_LABEL[scene.mode][phase]}
                  </div>

                  <ul className="mx-auto flex max-w-[720px] flex-col gap-1.5">
                    {scene.rows.map((r) => (
                      <li
                        key={r.item}
                        className="card-cosmic flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 rounded-lg px-3 py-2 text-center"
                      >
                        <code
                          style={{
                            font: "500 12px var(--font-mono-stack)",
                            color: "var(--foreground)",
                          }}
                        >
                          {r.item}
                        </code>
                        <span
                          style={{
                            font: "400 12px var(--font-mono-stack)",
                            color: "var(--color-text-muted)",
                          }}
                        >
                          {r.meta}
                        </span>
                        <span
                          style={{
                            font: "400 12px var(--font-mono-stack)",
                            color: acted ? "var(--hue-teal)" : "var(--hue-gold)",
                          }}
                        >
                          {acted ? `✓ ${r.done}` : `· ${r.pending}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              </AnimatePresence>

              <div className="mt-4 flex items-center justify-center gap-3">
                <span className="label-mono" style={{ color: "var(--color-text-muted)" }}>
                  {scene.meter.label}
                </span>
                <div
                  className="relative h-1 w-[180px] overflow-hidden rounded-full"
                  style={{ background: "var(--color-surface-4)" }}
                >
                  <motion.div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      background: alarm ? "var(--hue-gold)" : "var(--hue-teal)",
                    }}
                    animate={{ width: `${(value / scene.meter.of) * 100}%` }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                  />
                </div>
                <span className="label-mono" style={{ color: "var(--foreground)" }}>
                  {value} / {scene.meter.of}
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
