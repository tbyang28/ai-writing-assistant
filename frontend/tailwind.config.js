/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#6366f1',
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
        'ai-primary': '#6366f1',
        'surface': {
          DEFAULT: '#ffffff',
          secondary: '#f8fafc',
          hover: '#f1f5f9',
        },
        'text': {
          primary: '#0f172a',
          secondary: '#475569',
          muted: '#94a3b8',
        },
        'border': '#e2e8f0',
        'danger': '#ef4444',
        'success': '#22c55e',
      },
      fontFamily: {
        sans: ['"Inter"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        serif: ['"Noto Serif SC"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
}
