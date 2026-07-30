"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Scene from "@/components/scroll/Scene";
import WipeTitle from "@/components/scroll/WipeTitle";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";

/**
 * TrustLadderScene — the trust gradient, playable.
 *
 * Two mechanics from docs/en/features/agent-harness-layer.md are load-bearing
 * and no static chart conveys them, so this scene makes you perform them:
 *
 *   1. The asymmetry. "Trust rises slowly through people, falls instantly
 *      through incidents." Promotion is a press-and-hold that resets if you let
 *      go, moves exactly one level, and is blocked while an incident is open.
 *      An incident is one click: −1 immediately, or straight to L1 at high
 *      severity — no human needed, and the drop animation refuses to spring.
 *   2. The routing table. The same dangerous action lands somewhere different at
 *      every level: recorded only (L0), pending approval (L1/L2), staged behind
 *      a veto window where silence commits (L3), or straight to live (L4).
 *
 * Numbers are illustrative; the mechanics are not. The real veto window
 * defaults to 4 hours — compressed here so the point survives a page visit.
 */

const HOLD_MS = 1600;
/** Stands in for the real 4h autoCommitAt. */
const VETO_MS = 9000;
/**
 * Promotion needs an unbroken streak of succeeded runs. Without this gate you
 * could hold four times in a row and reach L4 in seconds, which would flatly
 * contradict the thing this scene exists to show.
 */
const STREAK_NEEDED = 3;

type Phase = "artifact" | "approval" | "staged" | "live" | "discarded" | "rejected";

interface Pending {
  phase: Phase;
  msLeft: number;
  pinned: boolean;
}

const LEVELS = [
  {
    id: "L0",
    name: "Shadow",
    hue: "#8b8a9c",
    desc: "Runs, but output is only recorded into artifacts. No proposals, no impact.",
  },
  {
    id: "L1",
    name: "Propose",
    hue: "#29d8e6",
    desc: "Every action creates a pending approval — full human-in-the-loop.",
  },
  {
    id: "L2",
    name: "Co-sign",
    hue: "#34e0b4",
    desc: "Safe actions run automatically; dangerous ones wait for approval.",
  },
  {
    id: "L3",
    name: "Veto window",
    hue: "#ffb020",
    desc: "Executes into a staged revision and commits after the window unless someone vetoes. Silence means consent.",
  },
  {
    id: "L4",
    name: "Autopilot",
    hue: "#d61f9f",
    desc: "Executes within capability and budget. The kill switch always applies.",
  },
] as const;

/** Where a dangerous patch lands at each level — the harness routing table. */
function routeFor(level: number): { phase: Phase; note: string } {
  if (level === 0)
    return { phase: "artifact", note: "recorded into artifacts · content untouched" };
  if (level <= 2)
    return {
      phase: "approval",
      note:
        level === 2
          ? "dangerous → awaiting approval · safe actions already auto-ran"
          : "awaiting approval · nothing moves until a human decides",
    };
  if (level === 3)
    return { phase: "staged", note: "staged revision · auto-commits unless vetoed" };
  return { phase: "live", note: "committed directly · kill switch still applies" };
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export default function TrustLadderScene() {
  const reduced = useStaticMotion();

  const [level, setLevel] = useState(2); // L2 — the pre-Content-OS harness baseline
  const [openIncidents, setOpenIncidents] = useState(0);
  const [runs, setRuns] = useState(14);
  const [hold, setHold] = useState(0); // 0–1
  const [pending, setPending] = useState<Pending | null>(null);
  const [log, setLog] = useState<string[]>([
    "grant · writer/content:write → L2 (default)",
  ]);
  const [lastDir, setLastDir] = useState<"up" | "down">("up");

  const holdRaf = useRef<number | null>(null);
  const holdStart = useRef(0);

  const say = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 4));
  }, []);

  const shortOfStreak = Math.max(0, STREAK_NEEDED - runs);
  const blocked = openIncidents > 0 || shortOfStreak > 0;
  const atTop = level >= 4;

  // ── Promotion: press and hold ──────────────────────────────────────────
  const stopHold = useCallback(() => {
    if (holdRaf.current != null) cancelAnimationFrame(holdRaf.current);
    holdRaf.current = null;
    setHold(0); // letting go resets — promotion is not a tap
  }, []);

  const completePromotion = useCallback(() => {
    stopHold();
    setLastDir("up");
    setLevel((l) => {
      const next = Math.min(4, l + 1);
      say(`promotion approved by human · ${LEVELS[l]!.id} → ${LEVELS[next]!.id} (+1 only)`);
      return next;
    });
    setRuns(0);
  }, [say, stopHold]);

  const startHold = useCallback(() => {
    if (blocked || atTop || holdRaf.current != null) return;
    holdStart.current = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - holdStart.current) / HOLD_MS);
      setHold(p);
      if (p >= 1) {
        completePromotion();
        return;
      }
      holdRaf.current = requestAnimationFrame(tick);
    };
    holdRaf.current = requestAnimationFrame(tick);
  }, [atTop, blocked, completePromotion]);

  useEffect(() => stopHold, [stopHold]);

  // ── Demotion: one click, no human required downstream ──────────────────
  const recordIncident = (severity: "warning" | "high") => {
    setLastDir("down");
    setOpenIncidents((n) => n + 1);
    setLevel((l) => {
      const next = severity === "high" ? 1 : Math.max(0, l - 1);
      say(
        severity === "high"
          ? `incident (high) · ${LEVELS[l]!.id} → L1 immediately · no approval needed`
          : `incident (warning) · ${LEVELS[l]!.id} → ${LEVELS[next]!.id} · automatic`
      );
      return next;
    });
  };

  const closeIncident = () => {
    setOpenIncidents((n) => Math.max(0, n - 1));
    say("incident closed by human · promotion gate reopens");
  };

  // ── The dangerous action, routed by level ──────────────────────────────
  const runAction = () => {
    const { phase, note } = routeFor(level);
    setPending({ phase, msLeft: VETO_MS, pinned: false });
    // L0 records only and L4 commits straight away — both are completed runs the
    // moment they happen. L1–L3 only count once a human or the window settles them.
    if (phase === "live" || phase === "artifact") setRuns((n) => n + 1);
    say(`agent:writer · updateItem(pricing-page) → ${phase} · ${note}`);
  };

  // Veto-window countdown. Silence is the default path: reaching zero commits.
  useEffect(() => {
    if (!pending || pending.phase !== "staged") return;
    const id = setInterval(() => {
      setPending((p) => {
        if (!p || p.phase !== "staged") return p;
        const msLeft = p.msLeft - 250;
        if (msLeft > 0) return { ...p, msLeft };
        say(
          p.pinned
            ? "auto-commit · auto_commit_partial — pinned field dropped from the patch"
            : "auto-commit · silence was consent · provenance recorded"
        );
        // A clean run is evidence — this is what the next promotion is earned on.
        setRuns((n) => n + 1);
        return { ...p, phase: "live", msLeft: 0 };
      });
    }, 250);
    return () => clearInterval(id);
  }, [pending, say]);

  const veto = () => {
    setPending((p) => (p ? { ...p, phase: "discarded" } : p));
    setLastDir("down");
    setOpenIncidents((n) => n + 1);
    setLevel((l) => Math.max(0, l - 1));
    say("veto · staging discarded — live was never touched · incident → demotion");
  };

  const decide = (approve: boolean) => {
    setPending((p) => (p ? { ...p, phase: approve ? "live" : "rejected" } : p));
    if (approve) setRuns((n) => n + 1);
    say(approve ? "approval granted by human · committed" : "approval rejected · nothing shipped");
  };

  const active = LEVELS[level]!;
  const rowH = 46;

  return (
    <Scene className="relative my-[8vh] overflow-hidden py-14">
      <hr className="rule-dashed absolute inset-x-0 top-0" />
      <hr className="rule-dashed absolute inset-x-0 bottom-0" />

      <div className="mx-auto max-w-[1200px] px-5">
        <WipeTitle label="[ 01B / TRUST LEDGER ]" title="Autonomy is earned" />

        <p
          className="font-serif-body mx-auto mt-4 max-w-[560px] text-center"
          style={{ font: "400 17px/28px var(--font-serif-stack)", color: "var(--color-text-secondary)" }}
        >
          Trust rises slowly, through a person. It falls instantly, through an
          incident. Try both — then watch where the same agent action lands.
        </p>

        <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ── Ladder + controls ───────────────────────────────────── */}
          <div className="card-cosmic p-6">
            <div className="flex items-baseline justify-between">
              <span className="label-mono">[ GRANT · WRITER / CONTENT:WRITE ]</span>
              <span
                className="label-mono"
                style={{ color: openIncidents ? "#ff4d8d" : undefined }}
              >
                {openIncidents} OPEN INCIDENT{openIncidents === 1 ? "" : "S"}
              </span>
            </div>

            {/* Rungs, L4 at the top so "up" means up */}
            <div className="relative mt-5" style={{ height: rowH * 5 }}>
              <motion.div
                aria-hidden
                className="absolute left-0 rounded-lg"
                style={{
                  width: "100%",
                  height: rowH - 6,
                  background: `linear-gradient(90deg, ${active.hue}22, transparent 70%)`,
                  boxShadow: `inset 0 0 0 1px ${active.hue}55`,
                }}
                animate={{ y: (4 - level) * rowH }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : lastDir === "up"
                      ? { type: "spring", stiffness: 120, damping: 18, mass: 0.9 }
                      : // Falling does not get to feel nice.
                        { duration: 0.16, ease: [0.9, 0, 1, 1] }
                }
              />
              {[...LEVELS].reverse().map((l, i) => {
                const idx = 4 - i;
                const on = idx <= level;
                return (
                  <div
                    key={l.id}
                    className="absolute inset-x-0 flex items-center gap-3 px-3"
                    style={{ top: i * rowH, height: rowH - 6 }}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        background: on ? l.hue : "var(--color-surface-4)",
                        boxShadow: idx === level ? `0 0 10px ${l.hue}` : "none",
                      }}
                    />
                    <span
                      className="label-mono"
                      style={{ color: idx === level ? l.hue : undefined, letterSpacing: "0.14em" }}
                    >
                      {l.id}
                    </span>
                    <span
                      style={{
                        font: `${idx === level ? 600 : 500} 13px var(--font-sans, inherit)`,
                        color: idx === level ? "var(--foreground)" : "var(--color-text-muted)",
                      }}
                    >
                      {l.name}
                    </span>
                  </div>
                );
              })}
            </div>

            <p
              className="font-serif-body mt-4 mb-0"
              style={{ font: "400 14px/23px var(--font-serif-stack)", color: "var(--color-text-secondary)" }}
            >
              {active.desc}
            </p>

            {/* Evidence — what a promotion is computed from */}
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1">
              {[
                [`${runs}`, "clean runs"],
                ["94%", "approve rate"],
                [`${openIncidents}`, "open incidents"],
              ].map(([v, k]) => (
                <span key={k} className="label-mono">
                  <span style={{ color: "var(--foreground)" }}>{v}</span> {k}
                </span>
              ))}
            </div>

            {/* Controls: hold to rise, click to fall */}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={blocked || atTop}
                // Pointer capture, not pointerleave: the :active transform makes
                // Chromium re-hit-test and fire pointerleave the instant you
                // press, which would cancel every hold before it started.
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  startHold();
                }}
                onPointerUp={stopHold}
                onPointerCancel={stopHold}
                onLostPointerCapture={stopHold}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    startHold();
                  }
                }}
                onKeyUp={stopHold}
                className="btn-pill btn-glass btn-md relative overflow-hidden"
                style={{ opacity: blocked || atTop ? 0.45 : 1, touchAction: "none" }}
              >
                {/* Fill shows the work; releasing early wipes it */}
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${hold * 100}%`,
                    background: "linear-gradient(90deg, rgba(255,176,32,0.45), rgba(214,31,159,0.4))",
                    transition: "width 60ms linear",
                  }}
                />
                <span>
                  {atTop
                    ? "At L4 — autopilot"
                    : openIncidents > 0
                      ? "Blocked · close the incident first"
                      : shortOfStreak > 0
                        ? `Needs ${shortOfStreak} more clean run${shortOfStreak === 1 ? "" : "s"}`
                        : hold > 0
                          ? "Hold…"
                          : "Hold to approve promotion"}
                </span>
              </button>

              <button
                type="button"
                onClick={() => recordIncident("warning")}
                className="btn-pill btn-glass btn-sm"
              >
                <span>Incident</span>
              </button>
              <button
                type="button"
                onClick={() => recordIncident("high")}
                className="btn-pill btn-sm"
                style={{ background: "rgba(255,77,141,0.16)", color: "#ff9ec0", boxShadow: "var(--ring-glass)" }}
              >
                <span>Incident · high</span>
              </button>
              {blocked && (
                <button type="button" onClick={closeIncident} className="btn-pill btn-glass btn-sm">
                  <span>Close incident</span>
                </button>
              )}
            </div>

            <p className="label-mono mt-4 mb-0" style={{ lineHeight: 1.6 }}>
              PROMOTION MOVES ONE LEVEL, NEEDS A HUMAN, AND NEVER AUTO-COMMITS ·
              DEMOTION IS AUTOMATIC · IRREVERSIBLE SKILLS ARE CAPPED AT L2
            </p>
          </div>

          {/* ── Where the action lands ──────────────────────────────── */}
          <div className="card-cosmic flex flex-col p-6">
            <div className="flex items-baseline justify-between">
              <span className="label-mono">[ AGENT ACTION · UPDATEITEM ]</span>
              <button type="button" onClick={runAction} className="btn-pill btn-solid btn-sm">
                <span>{pending ? "Run again" : "Run agent action"}</span>
              </button>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3" style={{ minHeight: 210 }}>
              {(["staged", "live"] as const).map((lane) => (
                <div
                  key={lane}
                  className="rounded-xl p-3"
                  style={{
                    background: "var(--color-surface-sunken)",
                    boxShadow: "var(--ring-glass)",
                  }}
                >
                  <span className="label-mono">
                    {lane === "staged" ? "STAGED / PENDING" : "LIVE CONTENT"}
                  </span>

                  <AnimatePresence mode="popLayout">
                    {pending &&
                      ((lane === "staged" &&
                        ["artifact", "approval", "staged"].includes(pending.phase)) ||
                        (lane === "live" && pending.phase === "live")) && (
                        <motion.div
                          key={pending.phase}
                          initial={reduced ? {} : { opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={reduced ? {} : { opacity: 0, scale: 0.96 }}
                          className="mt-3 rounded-lg p-3"
                          style={{
                            background: "var(--color-surface-3)",
                            boxShadow: "var(--ring-glass)",
                          }}
                        >
                          <div
                            style={{
                              font: "600 12px var(--font-sans, inherit)",
                              color: "var(--foreground)",
                            }}
                          >
                            pricing-page · body
                          </div>
                          <div className="label-mono mt-1">{routeFor(level).note}</div>

                          {pending.phase === "staged" && (
                            <>
                              <div className="mt-2 flex items-center gap-2">
                                <span
                                  className="label-mono"
                                  style={{ color: "#ffb020", letterSpacing: "0.16em" }}
                                >
                                  {fmt(pending.msLeft)}
                                </span>
                                <span className="label-mono">until auto-commit</span>
                              </div>
                              <div
                                aria-hidden
                                className="mt-2 h-1 overflow-hidden rounded-full"
                                style={{ background: "var(--color-surface-4)" }}
                              >
                                <div
                                  style={{
                                    width: `${(pending.msLeft / VETO_MS) * 100}%`,
                                    height: "100%",
                                    background: "#ffb020",
                                    transition: "width 250ms linear",
                                  }}
                                />
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={veto}
                                  className="btn-pill btn-sm"
                                  style={{
                                    background: "rgba(255,77,141,0.18)",
                                    color: "#ff9ec0",
                                    boxShadow: "var(--ring-glass)",
                                  }}
                                >
                                  <span>Veto</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPending((p) => {
                                      if (!p) return p;
                                      const next = !p.pinned;
                                      say(
                                        next
                                          ? "human pinned · pricing-page.body — the pin wins at commit"
                                          : "pin removed"
                                      );
                                      return { ...p, pinned: next };
                                    })
                                  }
                                  className="btn-pill btn-glass btn-sm"
                                >
                                  <span>{pending.pinned ? "Unpin field" : "Pin field"}</span>
                                </button>
                              </div>
                            </>
                          )}

                          {pending.phase === "approval" && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => decide(true)}
                                className="btn-pill btn-glass btn-sm"
                              >
                                <span>Approve</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => decide(false)}
                                className="btn-pill btn-glass btn-sm"
                              >
                                <span>Reject</span>
                              </button>
                            </div>
                          )}
                        </motion.div>
                      )}
                  </AnimatePresence>

                  {lane === "live" && (!pending || pending.phase !== "live") && (
                    <div className="label-mono mt-3" style={{ opacity: 0.7 }}>
                      {pending?.phase === "discarded"
                        ? "unchanged — the veto never let it through"
                        : "unchanged"}
                    </div>
                  )}
                  {lane === "live" && pending?.phase === "live" && pending.pinned && (
                    <div className="label-mono mt-2" style={{ color: "#34e0b4" }}>
                      PINNED FIELD KEPT · AUTO_COMMIT_PARTIAL
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Audit trail — the ledger is the product */}
            <div className="mt-auto pt-5">
              <span className="label-mono">[ TRUST LEDGER · AUDIT ]</span>
              <div className="mt-2 flex flex-col gap-1">
                {log.map((line, i) => (
                  <div
                    key={`${line}-${i}`}
                    className="label-mono"
                    style={{
                      opacity: 1 - i * 0.22,
                      color: i === 0 ? "var(--color-text-secondary)" : undefined,
                      letterSpacing: "0.06em",
                      textTransform: "none",
                    }}
                  >
                    {line}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <p className="label-mono mt-8 text-center" style={{ opacity: 0.7 }}>
          [ INTERACTIVE DEMO — MECHANICS ARE REAL, THE 4-HOUR WINDOW IS COMPRESSED ]
        </p>
      </div>
    </Scene>
  );
}
