import type { Priority, CredentialState } from '@/data/schema';

// ---------------------------------------------------------------- Section ----
export function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-600">
      {children}
    </p>
  );
}

export function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-5 border-b border-hair pb-3">
      <h2 className="text-2xl font-bold tracking-tight text-navy-900">{children}</h2>
      {sub && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">{sub}</p>}
    </div>
  );
}

// ------------------------------------------------------------------- Stat ----
export function StatCard({
  label,
  value,
  suffix,
  note,
  tone = 'default',
  big = false
}: {
  label: string;
  value: string | number;
  suffix?: string;
  note?: string;
  tone?: 'default' | 'teal' | 'navy' | 'amber';
  big?: boolean;
}) {
  const tones = {
    default: 'bg-white border-hair',
    teal: 'bg-teal-600 border-teal-600 text-white',
    navy: 'bg-navy-900 border-navy-900 text-white',
    amber: 'bg-white border-amber-500'
  } as const;
  const labelTone =
    tone === 'teal' || tone === 'navy' ? 'text-white/70' : 'text-muted';
  const valueTone =
    tone === 'teal' || tone === 'navy' ? 'text-white' : tone === 'amber' ? 'text-amber-700' : 'text-navy-900';

  return (
    <div className={`rounded-lg border p-4 ${tones[tone]}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-wider ${labelTone}`}>{label}</p>
      <p className={`mt-1.5 font-bold tabular-nums ${valueTone} ${big ? 'text-4xl' : 'text-3xl'}`}>
        {typeof value === 'number' ? value.toLocaleString('en-US') : value}
        {suffix && <span className="ml-1 text-base font-semibold opacity-70">{suffix}</span>}
      </p>
      {note && (
        <p className={`mt-1.5 text-xs leading-snug ${tone === 'teal' || tone === 'navy' ? 'text-white/70' : 'text-muted'}`}>
          {note}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Chips ----
const PRIORITY_STYLE: Record<Priority, string> = {
  A: 'bg-navy-900 text-white',
  B: 'bg-teal-600 text-white',
  C: 'border border-hair bg-white text-muted',
  X: 'bg-amber-700 text-white'
};

export function PriorityChip({ p }: { p: Priority }) {
  return (
    <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold ${PRIORITY_STYLE[p]}`}>
      {p}
    </span>
  );
}

export function CredChip({ state, label }: { state: CredentialState; label: string }) {
  const style: Record<CredentialState, string> = {
    verified: 'bg-teal-600 text-white',
    inferred: 'bg-teal-600/15 text-teal-600 border border-teal-600/30',
    unknown: 'bg-panel text-muted border border-hair',
    none: 'bg-white text-muted border border-hair line-through'
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${style[state]}`}>
      {label}
    </span>
  );
}

export function Tag({ children, tone = 'grey' }: { children: React.ReactNode; tone?: 'grey' | 'teal' | 'navy' | 'amber' }) {
  const t = {
    grey: 'bg-panel text-muted',
    teal: 'bg-teal-600/12 text-teal-600',
    navy: 'bg-navy-900/10 text-navy-900',
    amber: 'bg-amber-500/15 text-amber-700'
  } as const;
  return <span className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${t[tone]}`}>{children}</span>;
}

// ------------------------------------------------------------------- Bars ----
export function BarRow({
  label,
  value,
  max,
  sub,
  href
}: {
  label: string;
  value: number;
  max: number;
  sub?: string;
  href?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const inner = (
    <>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-navy-900">{label}</span>
        <span className="shrink-0 text-sm font-bold tabular-nums text-navy-900">{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-panel">
        <div className="h-full rounded-full bg-teal-600" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </>
  );
  return href ? (
    <a href={href} className="block rounded p-1 transition-colors hover:bg-panel/60">
      {inner}
    </a>
  ) : (
    <div className="p-1">{inner}</div>
  );
}

// ------------------------------------------------------------------ Donut ----
export function Donut({
  segments,
  centerLabel,
  centerValue
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel: string;
  centerValue: string | number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 60;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg viewBox="0 0 160 160" className="h-[150px] w-[150px] shrink-0 -rotate-90">
        <circle cx="80" cy="80" r={R} fill="none" stroke="#EEF2F5" strokeWidth="20" />
        {segments.map((s) => {
          const len = (s.value / total) * C;
          const el = (
            <circle
              key={s.label}
              cx="80"
              cy="80"
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth="20"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="flex-1 space-y-2">
        <div className="mb-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{centerLabel}</p>
          <p className="text-3xl font-bold tabular-nums text-navy-900">{centerValue}</p>
        </div>
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2.5 text-sm">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="flex-1 text-ink">{s.label}</span>
            <span className="font-bold tabular-nums text-navy-900">{s.value}</span>
            <span className="w-11 text-right text-xs text-muted">
              {Math.round((s.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- Callout ---
export function Callout({
  label,
  tone = 'teal',
  children
}: {
  label: string;
  tone?: 'teal' | 'amber';
  children: React.ReactNode;
}) {
  const border = tone === 'teal' ? 'border-l-teal-600' : 'border-l-amber-700';
  const text = tone === 'teal' ? 'text-teal-600' : 'text-amber-700';
  return (
    <div className={`rounded-r-lg border border-hair border-l-4 ${border} bg-white p-4`}>
      <p className={`mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] ${text}`}>{label}</p>
      <div className="space-y-2 text-sm leading-relaxed text-ink">{children}</div>
    </div>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-hair bg-white p-5 ${className}`}>{children}</div>;
}
