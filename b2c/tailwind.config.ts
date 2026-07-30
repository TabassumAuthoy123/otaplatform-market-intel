import type { Config } from 'tailwindcss';

/**
 * Same tokens as the market-intelligence dashboard so the two products read as
 * one family. Navy is structure, teal is action, amber is warning only.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 950: '#0B1A33', 900: '#13294B', 800: '#1B3A66', 700: '#254F87', 600: '#31649F' },
        teal: { 700: '#0B5A5E', 600: '#0F6F73', 500: '#12898E', 400: '#1FA8AE', 300: '#4FC4C9' },
        amber: { 700: '#9A5B00', 500: '#C77B10' },
        ink: '#1F2933',
        muted: '#5A6472',
        surface: '#F5F8FA',
        panel: '#EEF2F5',
        hair: '#DCE6EC'
      },
      fontFamily: { sans: ['var(--font-sans)', 'system-ui', 'sans-serif'] },
      boxShadow: {
        card: '0 1px 2px rgba(19,41,75,0.04), 0 8px 24px -12px rgba(19,41,75,0.18)',
        lift: '0 2px 4px rgba(19,41,75,0.06), 0 18px 40px -16px rgba(19,41,75,0.28)'
      },
      borderRadius: { xl2: '14px' }
    }
  },
  plugins: []
};
export default config;
