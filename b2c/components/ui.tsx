import Link from 'next/link';
import type { ReactNode } from 'react';

export function Section({
  children,
  className = '',
  tone = 'surface',
  id
}: {
  children: ReactNode;
  className?: string;
  tone?: 'surface' | 'white' | 'panel' | 'navy';
  id?: string;
}) {
  const bg =
    tone === 'white' ? 'bg-white' : tone === 'panel' ? 'bg-panel' : tone === 'navy' ? 'bg-navy-950 text-white' : 'bg-surface';
  return (
    <section id={id} className={`${bg} ${className}`}>
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">{children}</div>
    </section>
  );
}

export function SectionTitle({
  kicker,
  title,
  sub,
  onNavy = false
}: {
  kicker?: string;
  title: string;
  sub?: string;
  onNavy?: boolean;
}) {
  return (
    <div className="mb-9 max-w-3xl">
      {kicker && (
        <div className={`mb-2 text-[12px] font-bold uppercase tracking-[0.14em] ${onNavy ? 'text-teal-300' : 'text-teal-600'}`}>
          {kicker}
        </div>
      )}
      <h2 className={`rule text-[26px] font-bold leading-tight sm:text-[32px] ${onNavy ? 'text-white' : 'text-navy-900'}`}>
        {title}
      </h2>
      {sub && <p className={`mt-5 text-[15px] leading-relaxed ${onNavy ? 'text-white/70' : 'text-muted'}`}>{sub}</p>}
    </div>
  );
}

export function Button({
  href,
  children,
  variant = 'primary',
  className = ''
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'onNavy';
  className?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold transition-colors';
  const styles = {
    primary: 'bg-teal-600 text-white hover:bg-teal-700',
    ghost: 'border border-hair bg-white text-navy-900 hover:border-teal-500 hover:text-teal-700',
    onNavy: 'border border-white/25 bg-white/5 text-white hover:bg-white/12'
  }[variant];
  return (
    <Link href={href} className={`${base} ${styles} ${className}`}>
      {children}
    </Link>
  );
}

export function Chip({ children, tone = 'teal' }: { children: ReactNode; tone?: 'teal' | 'navy' | 'amber' | 'muted' }) {
  const styles = {
    teal: 'border-teal-600/25 bg-teal-600/10 text-teal-700',
    navy: 'border-navy-900/15 bg-navy-900/5 text-navy-900',
    amber: 'border-amber-700/25 bg-amber-700/10 text-amber-700',
    muted: 'border-hair bg-panel text-muted'
  }[tone];
  return <span className={`chip ${styles}`}>{children}</span>;
}

export function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-xl2 border border-hair bg-white px-5 py-6">
      <div className="tnum text-[34px] font-bold leading-none text-navy-900">{value}</div>
      <div className="mt-2 text-[13px] font-semibold text-ink">{label}</div>
      {sub && <div className="mt-1 text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

/** Simple line icons — no icon library, no decoration for its own sake. */
export function Icon({ name, className = 'h-6 w-6' }: { name: string; className?: string }) {
  const common = {
    className,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    viewBox: '0 0 24 24'
  };
  switch (name) {
    case 'plane':
      return (
        <svg {...common}>
          <path d="M2 13l20-7-7 20-3.5-8.5L2 13z" />
        </svg>
      );
    case 'kaaba':
      return (
        <svg {...common}>
          <path d="M12 2.5l8 4v11l-8 4-8-4v-11l8-4z" />
          <path d="M4 6.5l8 4 8-4M12 10.5v11" />
        </svg>
      );
    case 'bed':
      return (
        <svg {...common}>
          <path d="M3 18v-7h13a4 4 0 014 4v3M3 11V7M3 18h18" />
          <circle cx="7.5" cy="9" r="1.8" />
        </svg>
      );
    case 'passport':
      return (
        <svg {...common}>
          <rect x="5" y="2.5" width="14" height="19" rx="2" />
          <circle cx="12" cy="10" r="3.2" />
          <path d="M9 17h6" />
        </svg>
      );
    case 'map':
      return (
        <svg {...common}>
          <path d="M9 3l6 2 6-2v16l-6 2-6-2-6 2V5l6-2zM9 3v16M15 5v16" />
        </svg>
      );
    case 'briefcase':
      return (
        <svg {...common}>
          <rect x="3" y="7.5" width="18" height="12" rx="2" />
          <path d="M9 7.5V6a2 2 0 012-2h2a2 2 0 012 2v1.5M3 12.5h18" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6l8-3z" />
          <path d="M8.5 12l2.5 2.5 4.5-5" />
        </svg>
      );
    case 'arrow':
      return (
        <svg {...common}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}
