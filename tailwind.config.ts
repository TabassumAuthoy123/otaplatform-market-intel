import type { Config } from 'tailwindcss';

/**
 * One token set for both route groups: the Market Intelligence dashboard and
 * the /portal B2C storefront. Navy is structure, teal is action, amber is
 * warning only.
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './data/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Brand colours read CSS variables so the admin theme editor can repaint
        // the storefront without a rebuild. Everything else stays static.
        navy: {
          950: 'rgb(var(--c-navy-deep) / <alpha-value>)',
          900: 'rgb(var(--c-navy) / <alpha-value>)',
          800: '#1B3A66', 700: '#254F87', 600: '#31649F'
        },
        teal: {
          700: 'rgb(var(--c-primary-hover) / <alpha-value>)',
          600: 'rgb(var(--c-primary) / <alpha-value>)',
          500: '#12898E',
          400: 'rgb(var(--c-accent-light) / <alpha-value>)',
          300: 'rgb(var(--c-accent-light) / <alpha-value>)'
        },
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
