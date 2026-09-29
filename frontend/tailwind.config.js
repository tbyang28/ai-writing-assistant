/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Claude 橙（claude.ai 品牌色 #D97757 为基准的完整色阶）
        brand: {
          DEFAULT: '#D97757',
          50: '#FBF0EA',
          100: '#F6E1D4',
          200: '#EDC3AE',
          300: '#E2A184',
          400: '#DD8465',
          500: '#D97757',
          600: '#CB6242',
          700: '#A94F33',
          800: '#874027',
          900: '#6E341F',
        },
        'ai-primary': '#D97757',
        'surface': {
          DEFAULT: 'var(--surface)',
          secondary: 'var(--surface-secondary)',
          hover: 'var(--surface-hover)',
        },
        'text': {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        'border': 'var(--border-clr)',
        'danger': '#C0432F',
        'success': '#3E7A58',
      },
      fontFamily: {
        // Claude 风格：正文/UI 用 sans，标题与正文写作区用 serif（宋体感）
        sans: ['"Inter"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        serif: ['"Newsreader"', '"Noto Serif SC"', 'Georgia', 'serif'],
      },
      borderRadius: {
        'claude': '0.75rem',
      },
    },
  },
  plugins: [],
}
