"use client";

import { motion } from "framer-motion";

/**
 * The reconciliation control loop, visualized as a closed cycle:
 *   declare intent → detect drift → agent acts → reconcile → (loop)
 * with a human veto tap on the commit edge. This is the core mental
 * model of the Content OS, rendered as the hero's "live system" panel.
 */
export default function ControlLoop() {
  const nodes = [
    { id: "intent", label: "Intent / SLO", x: 150, y: 40, icon: "◇" },
    { id: "drift", label: "Drift detect", x: 270, y: 130, icon: "△" },
    { id: "agent", label: "Agent acts", x: 150, y: 220, icon: "▶" },
    { id: "reconcile", label: "Reconcile", x: 30, y: 130, icon: "↻" },
  ];

  return (
    <div className="relative w-full max-w-md">
      <div className="absolute inset-0 -z-10 bg-grid mask-radial animate-grid-fade" />
      <svg
        viewBox="0 0 300 270"
        className="w-full"
        role="img"
        aria-label="The reconciliation control loop: declare intent, detect drift, agent acts, reconcile, and repeat — with a human veto on commit."
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="#22c55e" />
          </marker>
        </defs>

        {/* Loop edges */}
        <g
          fill="none"
          stroke="#22c55e"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          markerEnd="url(#arrow)"
          className="animate-flow-dash"
          opacity="0.8"
        >
          <path d="M178,58 Q250,70 262,112" />
          <path d="M255,150 Q210,210 178,212" />
          <path d="M122,212 Q70,200 45,150" />
          <path d="M38,112 Q90,55 122,46" />
        </g>

        {/* Nodes */}
        {nodes.map((n, i) => (
          <motion.g
            key={n.id}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3 + i * 0.15, duration: 0.5, ease: "easeOut" }}
          >
            <circle
              cx={n.x}
              cy={n.y}
              r="26"
              fill="#0a0e14"
              stroke="#1a212c"
              strokeWidth="1.5"
            />
            <text
              x={n.x}
              y={n.y - 2}
              textAnchor="middle"
              fontSize="13"
              fill="#4ade80"
            >
              {n.icon}
            </text>
            <text
              x={n.x}
              y={n.y + 12}
              textAnchor="middle"
              fontSize="7.5"
              fill="#8b98a9"
              fontFamily="var(--font-mono), monospace"
            >
              {n.label}
            </text>
          </motion.g>
        ))}

        {/* Center: live status readout */}
        <motion.g
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.1, duration: 0.6 }}
        >
          <circle
            cx="150"
            cy="130"
            r="3"
            fill="#22c55e"
            className="animate-pulse-loop"
          />
          <text
            x="150"
            y="160"
            textAnchor="middle"
            fontSize="7"
            fill="#3a4452"
            fontFamily="var(--font-mono), monospace"
          >
            converging…
          </text>
        </motion.g>
      </svg>
    </div>
  );
}
