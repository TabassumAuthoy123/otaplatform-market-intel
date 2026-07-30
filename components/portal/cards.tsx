import Link from 'next/link';
import { bdt, type Hotel, type Package, type Route } from '@/lib/content';
import { Chip, Icon } from './ui';

export function RouteCard({ r }: { r: Route }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="tnum flex items-center gap-2 text-[19px] font-bold text-navy-900">
            <span>{r.fromCode}</span>
            <Icon name="arrow" className="h-4 w-4 text-teal-600" />
            <span>{r.toCode}</span>
          </div>
          <div className="mt-1 text-[13px] text-muted">
            {r.from} → {r.to}
          </div>
        </div>
        {r.tag && <Chip tone={r.tag === 'Cheapest' ? 'teal' : 'navy'}>{r.tag}</Chip>}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span>{r.airline}</span>
        <span className="tnum">{r.duration}</span>
        <span>{r.stops}</span>
      </div>

      <div className="mt-5 flex items-end justify-between border-t border-hair pt-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">From</div>
          <div className="tnum text-[20px] font-bold text-navy-900">{bdt(r.priceFrom)}</div>
        </div>
        <Link
          href={`/portal/flights?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`}
          className="rounded-lg border border-hair px-4 py-2 text-[13px] font-semibold text-teal-700 transition-colors hover:border-teal-500 hover:bg-teal-600/5"
        >
          View fares
        </Link>
      </div>
    </div>
  );
}

export function PackageCard({ p }: { p: Package }) {
  const tone = p.kind === 'Hajj' || p.kind === 'Umrah' ? 'teal' : 'navy';
  return (
    <div className="card flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <Chip tone={tone}>{p.kind}</Chip>
        {p.tag && <Chip tone="muted">{p.tag}</Chip>}
      </div>

      <h3 className="mt-4 text-[17px] font-bold leading-snug text-navy-900">{p.title}</h3>
      <div className="tnum mt-1 text-[12.5px] text-muted">{p.nights} nights</div>

      <ul className="mt-4 space-y-2">
        {p.includes.map((i) => (
          <li key={i} className="flex gap-2.5 text-[13px] leading-snug text-ink">
            <Icon name="check" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-teal-600" />
            <span>{i}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-end justify-between border-t border-hair pt-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Per person from</div>
          <div className="tnum text-[20px] font-bold text-navy-900">{bdt(p.priceFrom)}</div>
        </div>
        <Link
          href="/portal/contact"
          className="rounded-lg bg-navy-900 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-navy-800"
        >
          Enquire
        </Link>
      </div>
    </div>
  );
}

export function HotelCard({ h }: { h: Hotel }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15.5px] font-bold text-navy-900">{h.name}</h3>
          <div className="mt-0.5 text-[12.5px] text-muted">{h.city}</div>
        </div>
        <div className="tnum shrink-0 text-[12px] text-amber-700">{'★'.repeat(Math.max(0, Math.min(5, h.rating)))}</div>
      </div>
      <p className="mt-3 text-[13px] leading-snug text-muted">{h.note}</p>
      <div className="mt-4 flex items-end justify-between border-t border-hair pt-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Per night from</div>
          <div className="tnum text-[18px] font-bold text-navy-900">{bdt(h.priceFrom)}</div>
        </div>
        <Link
          href="/portal/contact"
          className="rounded-lg border border-hair px-4 py-2 text-[13px] font-semibold text-teal-700 transition-colors hover:border-teal-500"
        >
          Check dates
        </Link>
      </div>
    </div>
  );
}
