import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Cosmic accents
        accent: {
          violet: "rgb(123,97,255)",
          blue: "rgb(24,160,251)",
          green: "rgb(46,196,124)",
          red: "rgb(232,86,86)",
        },
        // Brand palette — re-pointed at the violet accent family
        brand: {
          50: "#f4f1ff",
          100: "#e8e2ff",
          200: "#d4c9ff",
          300: "#b6a4ff",
          400: "#9d85ff",
          500: "#7b61ff",
          600: "#6a4fe8",
          700: "#5840c4",
          800: "#453394",
          900: "#352a6e",
          950: "#26204a",
        },
        // Cosmic surfaces (spec: surface-1..4 + sunken; legacy numeric scale kept)
        surface: {
          1: "rgb(29,28,32)",
          2: "rgb(36,35,37)",
          3: "rgb(41,41,43)",
          4: "rgb(52,50,54)",
          sunken: "rgb(23,22,25)",
          950: "rgb(14,14,17)",
          900: "rgb(23,22,25)",
          800: "rgb(29,28,32)",
          700: "rgb(36,35,37)",
          600: "rgb(41,41,43)",
        },
        glass: "rgba(255,255,255,0.08)",
        "glass-hover": "rgba(255,255,255,0.14)",
        hairline: "rgba(255,255,255,0.08)",
        "hairline-strong": "rgba(255,255,255,0.16)",
        "txt-secondary": "rgb(189,189,192)",
        "txt-muted": "rgb(169,169,169)",
        "txt-faint": "rgb(155,155,160)",
        gold: "#F5C451",
      },
      borderRadius: {
        pill: "32px",
        card: "24px",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      boxShadow: {
        "ring-glass": "inset 0 0 0 1px rgba(255,255,255,0.08)",
        "ring-glass-strong": "inset 0 0 0 1px rgba(255,255,255,0.16)",
        "glow-violet": "0 0 80px rgba(123,97,255,0.45)",
        "glow-blue": "0 0 80px rgba(24,160,251,0.4)",
      },
      animation: {
        "fade-in": "fadeIn 0.5s ease-in-out",
        "slide-up": "slideUp 0.4s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
