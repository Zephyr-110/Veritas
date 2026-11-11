/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        yes: {
          DEFAULT: "#34d399",
          dim: "rgba(52, 211, 153, 0.12)",
        },
        no: {
          DEFAULT: "#fb7185",
          dim: "rgba(251, 113, 133, 0.12)",
        },
        accent: {
          DEFAULT: "#22d3ee",
          dim: "rgba(34, 211, 238, 0.12)",
        },
        ink: "#f4f4f5",
        mute: "#a1a1aa",
        line: "rgba(118, 140, 170, 0.28)",
        panel: "rgba(28, 33, 46, 0.92)",
        panel2: "rgba(32, 38, 52, 0.96)",
        bg: "#0B0E14",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-sans)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "IBM Plex Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 24px 80px rgba(0, 0, 0, 0.35)",
      },
      maxWidth: {
        page: "var(--page)",
      },
      borderRadius: {
        box: "var(--radius)",
      },
    },
  },
  plugins: [],
};
