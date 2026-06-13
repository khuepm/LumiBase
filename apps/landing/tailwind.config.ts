import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Control-room surface ramp (near-black → slate)
        ink: {
          950: "#05070a",
          900: "#0a0e14",
          800: "#11161f",
          700: "#1a212c",
          600: "#252e3b",
          500: "#3a4452",
        },
        // Signal green — the "live / converged" accent
        signal: {
          400: "#4ade80",
          500: "#22c55e",
          600: "#16a34a",
        },
        // Amber — the "veto / attention" accent
        warn: {
          400: "#fbbf24",
          500: "#f59e0b",
        },
      },
      fontFamily: {
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      keyframes: {
        "pulse-loop": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        "flow-dash": {
          to: { strokeDashoffset: "-16" },
        },
        "grid-fade": {
          "0%, 100%": { opacity: "0.06" },
          "50%": { opacity: "0.12" },
        },
      },
      animation: {
        "pulse-loop": "pulse-loop 2.4s ease-in-out infinite",
        scan: "scan 3.5s linear infinite",
        "flow-dash": "flow-dash 1s linear infinite",
        "grid-fade": "grid-fade 6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
