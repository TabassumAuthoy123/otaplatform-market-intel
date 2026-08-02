'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { SEGMENTS, CLUSTERS } from '@/data/schema';

/**
 * Counts arrive as props. This is a client component, and the dataset now lives
 * in content/agencies.json, which only the server can read.
 */
export default function Nav({
  segCounts = {},
  clusterCounts = {}
}: {
  segCounts?: Record<string, number>;
  clusterCounts?: Record<string, number>;
}) {
  const countSeg = (code: string) => segCounts[code] ?? 0;
  const countCluster = (id: string) => clusterCounts[id] ?? 0;
  const path = usePathname();
  const [open, setOpen] = useState<'seg' | 'cluster' | null>(null);
  const [mobile, setMobile] = useState(false);

  const link = (href: string, label: string) => (
    <Link
      href={href}
      className={`rounded px-3 py-2 text-sm transition-colors ${
        path === href ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <header className="sticky top-0 z-50 border-b border-navy-800 bg-navy-950 no-print">
      <div className="mx-auto flex max-w-[1400px] items-center gap-1 px-5 py-3 lg:px-8">
        <Link href="/" className="mr-4 flex flex-col leading-tight">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-teal-400">
            Softifybd · OTA Platform
          </span>
          <span className="text-[15px] font-bold text-white">Market Intelligence</span>
        </Link>

        <nav className="ml-auto hidden items-center gap-1 lg:flex">
          {link('/', 'Dashboard')}
          {link('/agencies', 'Agency Database')}

          {/* Segments dropdown */}
          <div
            className="relative"
            onMouseEnter={() => setOpen('seg')}
            onMouseLeave={() => setOpen(null)}
          >
            <button className="rounded px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white">
              Segments ▾
            </button>
            {open === 'seg' && (
              <div className="absolute right-0 top-full w-[420px] overflow-hidden rounded-lg border border-hair bg-white shadow-xl">
                {SEGMENTS.map((s) => (
                  <Link
                    key={s.code}
                    href={`/agencies?segment=${s.code}`}
                    className="flex items-start gap-3 border-b border-hair px-4 py-3 last:border-0 hover:bg-panel"
                  >
                    <span className="mt-0.5 rounded bg-navy-900 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {s.code}
                    </span>
                    <span className="flex-1">
                      <span className="block text-sm font-semibold text-navy-900">{s.shortName}</span>
                      <span className="block text-xs text-muted">{s.tierHint}</span>
                    </span>
                    <span className="text-sm font-bold text-teal-600">{countSeg(s.code)}</span>
                  </Link>
                ))}
                <Link href="/segments" className="block bg-panel px-4 py-2.5 text-xs font-semibold text-teal-600">
                  All segments explained →
                </Link>
              </div>
            )}
          </div>

          {/* Clusters dropdown */}
          <div
            className="relative"
            onMouseEnter={() => setOpen('cluster')}
            onMouseLeave={() => setOpen(null)}
          >
            <button className="rounded px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white">
              Clusters ▾
            </button>
            {open === 'cluster' && (
              <div className="absolute right-0 top-full max-h-[70vh] w-[400px] overflow-y-auto rounded-lg border border-hair bg-white shadow-xl scroll-thin">
                {CLUSTERS.map((c) => (
                  <Link
                    key={c.id}
                    href={`/agencies?cluster=${c.id}`}
                    className="flex items-center gap-3 border-b border-hair px-4 py-2.5 last:border-0 hover:bg-panel"
                  >
                    <span className="flex-1">
                      <span className="block text-sm font-medium text-navy-900">{c.name}</span>
                      <span className="block text-xs text-muted">
                        {c.district} · Phase {c.phase}
                      </span>
                    </span>
                    <span className="text-sm font-bold text-teal-600">{countCluster(c.id)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {link('/agencies?priority=A', 'Call First (A)')}

          {/* The consumer-facing storefront — separate product area, so it is
              styled as an outlined link rather than another dashboard tab. */}
          <Link
            href="/portal"
            className="ml-1 rounded border border-teal-400/50 px-3 py-2 text-sm text-teal-300 transition-colors hover:border-teal-400 hover:bg-teal-400/10 hover:text-white"
          >
            B2C Portal ↗
          </Link>

          <a
            href="/api/agencies?format=csv"
            className="ml-2 rounded bg-teal-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-teal-500"
          >
            Export CSV
          </a>
        </nav>

        <button
          onClick={() => setMobile(!mobile)}
          className="ml-auto rounded border border-white/20 px-3 py-1.5 text-sm text-white lg:hidden"
        >
          Menu
        </button>
      </div>

      {mobile && (
        <div className="border-t border-navy-800 bg-navy-900 px-5 py-3 lg:hidden">
          <div className="flex flex-col gap-1">
            {link('/', 'Dashboard')}
            {link('/agencies', 'Agency Database')}
            {link('/segments', 'Segments')}
            {link('/agencies?priority=A', 'Call First (A)')}
            {link('/portal', 'B2C Portal ↗')}
          </div>
        </div>
      )}
    </header>
  );
}
