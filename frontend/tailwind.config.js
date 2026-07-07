/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#0D1117",
        panel: "#151B23",
        border: "#232B36",
        ink: "#E6EDF3",
        muted: "#7D8590",
        pulse: "#2DD4BF",
        succeeded: "#3FB950",
        failed: "#F85149",
        retrying: "#D29922",
        pending: "#7D8590",
      },
      fontFamily: {
        mono: ["IBM Plex Mono", "monospace"],
        sans: ["Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
