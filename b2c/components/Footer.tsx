import Link from 'next/link';
import type { SiteContent } from '@/lib/content';

export function Footer({ c }: { c: SiteContent }) {
  return (
    <footer className="bg-navy-950 text-white">
      <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-white text-[13px] font-bold text-navy-900">
                {c.brand.logoMark}
              </span>
              <span className="text-[15px] font-bold">{c.brand.name}</span>
            </div>
            <p className="mt-4 max-w-sm text-[13px] leading-relaxed text-white/60">{c.footer.blurb}</p>
            <div className="tnum mt-5 space-y-1 text-[13px] text-white/80">
              <div>{c.brand.hotline}</div>
              <div>{c.brand.email}</div>
            </div>
            <p className="mt-4 max-w-sm text-[12px] leading-relaxed text-white/45">{c.brand.address}</p>
          </div>

          {c.footer.columns.map((col) => (
            <div key={col.title}>
              <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-300">{col.title}</div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={col.title + l.label}>
                    <Link href={l.href} className="text-[13.5px] text-white/70 transition-colors hover:text-white">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-wrap items-center gap-2 border-t border-white/10 pt-7">
          {c.paymentMethods.map((p) => (
            <span key={p} className="rounded border border-white/15 px-2.5 py-1 text-[11px] text-white/60">
              {p}
            </span>
          ))}
        </div>

        <div className="mt-7 space-y-2 text-[12px] text-white/45">
          <p>{c.footer.disclaimer}</p>
          <p>{c.footer.legal}</p>
        </div>
      </div>
    </footer>
  );
}
