import Link from 'next/link';
import type { SiteContent } from '@/lib/content';

export function Header({ c }: { c: SiteContent }) {
  return (
    <>
      {c.announcement?.enabled && (
        <div className="bg-amber-700 text-white">
          <div className="mx-auto max-w-6xl px-5 py-2 text-[12.5px] sm:px-8">{c.announcement.text}</div>
        </div>
      )}

      <header className="sticky top-0 z-40 border-b border-hair bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3.5 sm:px-8">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-navy-900 text-[13px] font-bold text-white">
              {c.brand.logoMark}
            </span>
            <span className="leading-tight">
              <span className="block text-[15px] font-bold text-navy-900">{c.brand.name}</span>
              <span className="block text-[11px] text-muted">{c.brand.company}</span>
            </span>
          </Link>

          <nav className="hidden flex-1 items-center gap-1 lg:flex">
            {c.nav.map((n) => (
              <Link
                key={n.href + n.label}
                href={n.href}
                className="rounded-md px-3 py-2 text-[13.5px] font-medium text-ink transition-colors hover:bg-panel hover:text-teal-700"
              >
                {n.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 lg:ml-0">
            <a
              href={`tel:${c.brand.hotline.replace(/[^0-9+]/g, '')}`}
              className="tnum hidden text-[13px] font-semibold text-navy-900 hover:text-teal-700 sm:block"
            >
              {c.brand.hotline}
            </a>
            <Link
              href="/agents"
              className="rounded-lg bg-teal-600 px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-teal-700"
            >
              Agent login
            </Link>
          </div>
        </div>

        {/* mobile nav — horizontal scroll, no hamburger state to get wrong */}
        <nav className="flex gap-1 overflow-x-auto border-t border-hair px-5 py-2 lg:hidden">
          {c.nav.map((n) => (
            <Link
              key={'m' + n.href + n.label}
              href={n.href}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-panel"
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
    </>
  );
}
