/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        yes: {
          DEFAULT: "var(--yes)",
          dim: "var(--yes-soft)",
        },
        no: {
          DEFAULT: "var(--no)",
          dim: "var(--no-soft)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          dim: "var(--hair)",
        },
        ink: "var(--ink)",
        mute: "var(--ink-2)",
        line: "var(--line)",
        panel: "var(--float-bg)",
        panel2: "var(--card-bg)",
        bg: "var(--bg)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ['"Newsreader"', '"Noto Serif SC"', '"Songti SC"', "Georgia", "serif"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        glow: "var(--float-shadow)",
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
