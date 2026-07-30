import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './data/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 950: '#0B1A33', 900: '#13294B', 800: '#1B3A66', 700: '#254F87' },
        teal: { 600: '#0F6F73', 500: '#12898E', 400: '#1FA8AE' },
        amber: { 700: '#9A5B00', 500: '#C77B10' },
        ink: '#1F2933',
        muted: '#5A6472',
        surface: '#F5F8FA',
        panel: '#EEF2F5',
        hair: '#DCE6EC'
      },
      fontFamily: { sans: ['var(--font-sans)', 'system-ui', 'sans-serif'] }
    }
  },
  plugins: []
};
export default config;
