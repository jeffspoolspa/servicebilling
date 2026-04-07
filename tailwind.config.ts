import type { Config } from "tailwindcss"

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "rgb(var(--bg) / <alpha-value>)",
          elev: "rgb(var(--bg-elev) / <alpha-value>)",
          surface: "rgb(var(--surface) / <alpha-value>)",
        },
        line: {
          DEFAULT: "rgb(var(--line) / <alpha-value>)",
          soft: "rgb(var(--line-soft) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--ink) / <alpha-value>)",
          dim: "rgb(var(--ink-dim) / <alpha-value>)",
          mute: "rgb(var(--ink-mute) / <alpha-value>)",
        },
        cyan: {
          DEFAULT: "rgb(var(--cyan) / <alpha-value>)",
          deep: "rgb(var(--cyan-deep) / <alpha-value>)",
        },
        teal: "rgb(var(--teal) / <alpha-value>)",
        sun: "rgb(var(--sun) / <alpha-value>)",
        coral: "rgb(var(--coral) / <alpha-value>)",
        grass: "rgb(var(--grass) / <alpha-value>)",
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "14px",
        DEFAULT: "10px",
      },
      boxShadow: {
        card: "0 1px 0 0 rgb(255 255 255 / 0.03) inset, 0 20px 40px -24px rgb(0 0 0 / 0.4)",
      },
      keyframes: {
        fadeup: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        fadeup: "fadeup 0.5s ease both",
      },
    },
  },
  plugins: [],
}
export default config
