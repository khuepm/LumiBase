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
        // Warm surface ramp (raised cards → sunken wells)
        surface: {
          1: "#1c120a",
          2: "#241709",
          3: "#2c1c0e",
          4: "#382416",
          sunken: "#150c05",
        },
        // Brand accents — totality orange is primary
        accent: {
          DEFAULT: "#e6500a",
          bright: "#ff8c00",
          amber: "#ffa000",
        },
        cream: {
          DEFAULT: "#f4f2ff",
          soft: "#c4a8ff",
        },
        // Legacy accent names remapped to the eclipse palette
        violet: {
          DEFAULT: "#9b5cff",
          soft: "#b06bff",
        },
        cosmic: {
          blue: "#ffa000",
          green: "#5d6c49",
          red: "#ff6b6b",
        },
        // Text ramp
        secondary: "rgba(255, 237, 215, 0.72)",
        muted: "rgba(255, 237, 215, 0.52)",
        // Legacy control-room ramp (pricing/legal pages)
        ink: {
          950: "#07060c",
          900: "#0b0a11",
          800: "#100f18",
          700: "#15141f",
          600: "#1b1926",
          500: "#262433",
        },
        // Legacy accents remapped to the eclipse palette
        signal: {
          400: "#ff8c00",
          500: "#e6500a",
          600: "#dc5000",
        },
        warn: {
          400: "#ffbf02",
          500: "#ffa000",
        },
      },
      borderRadius: {
        pill: "32px",
        card: "20px",
      },
      fontFamily: {
        serif: ["var(--font-serif)", "Georgia", "serif"],
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
