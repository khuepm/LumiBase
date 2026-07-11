"use client";

import { useState } from "react";

/**
 * Interactive trust-gradient (L0–L4) selector for the "AI Harness" feature
 * card. Descriptions mirror docs/en/ai-native-vision.md.
 */

const sans = "var(--font-sans, inherit)";

const LEVELS = [
  {
    id: "L0",
    name: "Shadow",
    desc: "The agent runs, output is only recorded into artifacts — no proposals, no impact.",
  },
  {
    id: "L1",
    name: "Propose",
    desc: "Every action creates a pending approval — full human-in-the-loop.",
  },
  {
    id: "L2",
    name: "Co-sign",
    desc: "Safe actions run automatically; dangerous actions still wait for approval.",
  },
  {
    id: "L3",
    name: "Veto window",
    desc: "A dangerous action executes into a staged revision and auto-commits after the window. Silence commits; the kill switch stays armed.",
  },
  {
    id: "L4",
    name: "Autopilot",
    desc: "Executes directly within capability and budget. A kill switch is always available.",
  },
];

export default function TrustViz() {
  const [active, setActive] = useState(3);
  const level = LEVELS[active]!;

  return (
    <div className="w-full p-6">
      <div className="flex gap-2" role="group" aria-label="Autonomy level">
        {LEVELS.map((l, i) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setActive(i)}
            aria-pressed={i === active}
            aria-label={`${l.id} — ${l.name}`}
            className="flex-1 cursor-pointer border-0 bg-transparent p-0 text-center"
          >
            <div
              className="mb-2 h-1.5 rounded-[3px] transition-colors"
              style={{
                background: i <= active ? "var(--color-violet)" : "var(--color-surface-4)",
                boxShadow: i <= active ? "0 0 10px rgba(230,80,10,0.7)" : "none",
              }}
            />
            <span
              style={{
                font: `600 12px ${sans}`,
                color: i === active ? "var(--foreground)" : "var(--color-text-muted)",
              }}
            >
              {l.id}
            </span>
          </button>
        ))}
      </div>
      <div
        className="mt-4"
        style={{ font: `500 12px/1.5 ${sans}`, color: "var(--color-text-secondary)" }}
      >
        Currently at{" "}
        <b style={{ color: "var(--foreground)" }}>
          {level.id} — {level.name}
        </b>
        . {level.desc}
      </div>
    </div>
  );
}
