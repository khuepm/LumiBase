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
        // Cosmic surface ramp (raised cards → sunken wells)
        surface: {
          1: "rgb(29, 28, 32)",
          2: "rgb(36, 35, 37)",
          3: "rgb(41, 41, 43)",
          4: "rgb(52, 50, 54)",
          sunken: "rgb(23, 22, 25)",
        },
        // Brand accents — violet is primary
        violet: {
          DEFAULT: "rgb(123, 97, 255)",
          soft: "rgb(149, 128, 255)",
        },
        cosmic: {
          blue: "rgb(24, 160, 251)",
          green: "rgb(46, 196, 124)",
          red: "rgb(232, 86, 86)",
        },
        // Text ramp
        secondary: "rgb(189, 189, 192)",
        muted: "rgb(169, 169, 169)",
        // Legacy control-room ramp (pricing/legal pages)
        ink: {
          950: "#0e0e11",
          900: "#141316",
          800: "#1d1c20",
          700: "#29292b",
          600: "#343236",
          500: "#4a484e",
        },
        // Legacy accents remapped to the cosmic palette
        signal: {
          400: "#9580ff",
          500: "#7b61ff",
          600: "#6a50ea",
        },
        warn: {
          400: "#fbbf24",
          500: "#f59e0b",
        },
      },
      borderRadius: {
        pill: "32px",
        card: "24px",
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
