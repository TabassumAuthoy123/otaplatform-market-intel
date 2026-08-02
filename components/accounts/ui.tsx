import type { ReactNode } from 'react';
import { LABEL } from '@/lib/accounting';

export function PageHead({ kicker, title, sub, actions }: { kicker?: string; title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-3xl">
        {kicker && <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-teal-600">{kicker}</div>}
        <h1 className="text-[24px] font-bold leading-tight text-navy-900 sm:text-[28px]">{title}</h1>
        {sub && <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Tile({
  label, value, sub, tone = 'plain'
}: {
  label: string; value: string; sub?: string; tone?: 'plain' | 'good' | 'warn' | 'bad';
}) {
  const accent = {
    plain: 'text-navy-900',
    good: 'text-teal-700',
    warn: 'text-amber-700',
    bad: 'text-amber-700'
  }[tone];
  return (
    <div className="rounded-xl2 border border-hair bg-white px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`tnum mt-1.5 text-[24px] font-bold leading-none ${accent}`}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

export function Panel({ title, sub, children, actions }: { title: string; sub?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl2 border border-hair bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hair px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-bold text-navy-900">{title}</h2>
          {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
        </div>
        {actions}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export function Table({ head, children, right = [] }: { head: string[]; children: ReactNode; right?: number[] }) {
  return (
    <table className="w-full min-w-[640px] text-left">
      <thead>
        <tr className="border-b border-hair bg-panel">
          {head.map((h, i) => (
            <th
              key={h + i}
              className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted ${right.includes(i) ? 'text-right' : ''}`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** `children` is optional so a spacer cell can be written as a bare <Td />. */
export function Td({ children = null, right = false, mono = false, className = '' }: { children?: ReactNode; right?: boolean; mono?: boolean; className?: string }) {
  return (
    <td className={`border-b border-hair px-4 py-2.5 text-[13px] ${right ? 'text-right' : ''} ${mono ? 'tnum' : ''} ${className}`}>
      {children}
    </td>
  );
}

export function StatusChip({ value }: { value: string }) {
  const tone =
    value === 'paid'
      ? 'border-teal-600/30 bg-teal-600/10 text-teal-700'
      : value === 'partially_paid'
        ? 'border-amber-700/30 bg-amber-700/10 text-amber-700'
        : value === 'cancelled'
          ? 'border-hair bg-panel text-muted line-through'
          : value === 'draft' || value === 'unpaid'
            ? 'border-hair bg-panel text-muted'
            : 'border-navy-900/20 bg-navy-900/5 text-navy-900';
  return <span className={`chip ${tone}`}>{LABEL[value] ?? value}</span>;
}

/** Simple horizontal bar for report breakdowns — no chart library. */
export function Bar({ value, max, label, amount }: { value: number; max: number; label: string; amount: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="py-2">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-ink">{label}</span>
        <span className="tnum text-[13px] font-semibold text-navy-900">{amount}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-panel">
        <div className="h-full rounded-full bg-teal-600" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-10 text-center text-[13px] text-muted">{children}</div>;
}
