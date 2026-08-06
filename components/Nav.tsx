'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

/**
 * Counts arrive as props. This is a client component and the dataset lives in
 * content/crm-leads.json, which only the server can read.
 */
export default function Nav({
  credentialCounts = {},
  cityCounts = {},
  total = 0,
  hidden = []
}: {
  credentialCounts?: Record<string, number>;
  cityCounts?: Record<string, number>;
  total?: number;
  /**
   * Hrefs the panel toggles have switched OFF.
   *
   * Deliberately the disabled list and not the enabled one. The enabled version of
   * this prop was written first and immediately broke two links: it carried only
   * the four market-intelligence modules, so `/portal` and `/accounts` — which
   * belong to other groups and are never toggleable here — matched nothing and
   * vanished from the nav. An allowlist has to enumerate everything that may pass;
   * a blocklist only has to name what must not, and an empty one is the correct
   * default for a component rendered from more than one place.
   */
  hidden?: string[];
}) {
  const path = usePathname();
  const [open, setOpen] = useState<'cred' | 'city' | null>(null);
  const [mobile, setMobile] = useState(false);

  // Compare the path only. Several links here carry a query — /agencies?engine=…
  // is still the agencies module and must disappear with it.
  const on = (href: string) => !hidden.includes(href.split('?')[0]);

  /**
   * Returns null for a disabled module, so `{link('/competitors', …)}` simply
   * renders nothing. Filtering at the call site instead would mean a conditional
   * around each of the six call sites here plus the mobile menu — and the mobile
   * one is where a missed case hides.
   */
  const link = (href: string, label: string) =>
    on(href) ? (
      <Link
        key={href + label}
        href={href}
        className={`rounded px-3 py-2 text-sm transition-colors ${
          path === href ? 'bg-white/15 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
        }`}
      >
        {label}
      </Link>
    ) : null;

  const CREDENTIALS: [string, string][] = [
    ['iata', 'IATA accredited'],
    ['hajj', 'Hajj licence (MoRA)'],
    ['baira', 'BAIRA recruiting licence'],
    ['toab', 'TOAB member'],
    ['none', 'No number printed']
  ];

  const cities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 14);

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
          {link('/agencies', `Agencies${total ? ` (${total})` : ''}`)}
          {link('/competitors', 'Competitors')}

          {/*
            Both dropdowns are entirely filters over /agencies — every link inside
            them lands there. If that module is off they have nowhere to go, so they
            go with it rather than staying as two menus that all 404.
          */}
          {on('/agencies') && (
          <div className="relative" onMouseEnter={() => setOpen('cred')} onMouseLeave={() => setOpen(null)}>
            <button className="rounded px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white">
              Credentials ▾
            </button>
            {open === 'cred' && (
              <div className="absolute right-0 top-full w-[340px] overflow-hidden rounded-lg border border-hair bg-white shadow-xl">
                {CREDENTIALS.map(([key, label]) => (
                  <Link
                    key={key}
                    href={`/agencies?credential=${key}`}
                    className="flex items-center justify-between gap-3 border-b border-hair px-4 py-3 last:border-0 hover:bg-panel"
                  >
                    <span className="text-sm text-navy-900">{label}</span>
                    <span className="text-sm font-bold text-teal-600">{credentialCounts[key] ?? 0}</span>
                  </Link>
                ))}
                <Link href="/agencies" className="block bg-panel px-4 py-2.5 text-xs font-semibold text-teal-600">
                  All {total} agencies →
                </Link>
              </div>
            )}
          </div>
          )}

          {on('/agencies') && (
          <div className="relative" onMouseEnter={() => setOpen('city')} onMouseLeave={() => setOpen(null)}>
            <button className="rounded px-3 py-2 text-sm text-white/75 hover:bg-white/10 hover:text-white">
              Cities ▾
            </button>
            {open === 'city' && (
              <div className="scroll-thin absolute right-0 top-full max-h-[70vh] w-[300px] overflow-y-auto rounded-lg border border-hair bg-white shadow-xl">
                {cities.map(([city, n]) => (
                  <Link
                    key={city}
                    href={`/agencies?city=${encodeURIComponent(city)}`}
                    className="flex items-center justify-between gap-3 border-b border-hair px-4 py-2.5 last:border-0 hover:bg-panel"
                  >
                    <span className="text-sm text-navy-900">{city}</span>
                    <span className="text-sm font-bold text-teal-600">{n}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          )}

          {link('/agencies?engine=none_seen', 'No website')}
          {link('/segments', 'Segments')}

          <a
            href="/api/crm/export?format=xlsx"
            className="ml-2 rounded bg-teal-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-teal-500"
          >
            Export Excel
          </a>

          <Link
            href="/portal"
            className="ml-1 rounded border border-teal-400/50 px-3 py-2 text-sm text-teal-300 transition-colors hover:border-teal-400 hover:bg-teal-400/10 hover:text-white"
          >
            B2C Portal ↗
          </Link>
          <Link
            href="/accounts"
            className="ml-1 rounded border border-teal-400/50 px-3 py-2 text-sm text-teal-300 transition-colors hover:border-teal-400 hover:bg-teal-400/10 hover:text-white"
          >
            Accounts ↗
          </Link>
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
            {link('/agencies', 'Agencies')}
            {link('/competitors', 'Competitors')}
            {link('/agencies?credential=iata', 'IATA accredited')}
            {link('/agencies?engine=none_seen', 'No website')}
            {link('/segments', 'Segments')}
            {link('/portal', 'B2C Portal ↗')}
            {link('/accounts', 'Accounts ↗')}
          </div>
        </div>
      )}
    </header>
  );
}
