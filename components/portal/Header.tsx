import Link from 'next/link';
import { visibleNav, type SiteContent } from '@/lib/content';

/**
 * The storefront header.
 *
 * Menu entries come from `visibleNav`, not from `c.nav` directly, so an entry
 * switched off in the admin portal disappears from the desktop bar, the mega
 * panel and the mobile strip together. Filtering in three separate places is
 * how a "disabled" link survives in one of them and stays clickable.
 *
 * The mega panel opens on hover and on keyboard focus, in CSS only. A
 * JavaScript dropdown would turn the whole header into a client component to do
 * what `group-hover` already does, and it would stop working while hydration is
 * still in flight — which on a Dhaka mobile connection is a real window.
 */
export function Header({ c }: { c: SiteContent }) {
  const nav = visibleNav(c);

  return (
    <>
      {/* Way back to the dashboard — this storefront lives inside it. */}
      <div className="border-b border-navy-800 bg-navy-950">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-1.5 sm:px-8">
          <Link href="/" className="text-[11.5px] font-semibold text-teal-300 hover:text-white">
            ← Market Intelligence
          </Link>
          <span className="text-[11px] text-white/40">B2C portal preview</span>
        </div>
      </div>

      {c.announcement?.enabled && (
        <div className="bg-amber-700 text-white">
          <div className="mx-auto max-w-6xl px-5 py-2 text-[12.5px] sm:px-8">{c.announcement.text}</div>
        </div>
      )}

      <header className="sticky top-0 z-40 border-b border-hair bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-5 py-3.5 sm:px-8">
          <Link href="/portal" className="flex shrink-0 items-center gap-2.5" aria-label="B2C portal home">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-navy-900 text-[13px] font-bold text-white">
              {c.brand.logoMark}
            </span>
            <span className="leading-tight">
              <span className="block text-[15px] font-bold text-navy-900">{c.brand.name}</span>
              <span className="block text-[11px] text-muted">{c.brand.company}</span>
            </span>
          </Link>

          <nav aria-label="Main menu" className="hidden flex-1 items-center gap-1 lg:flex">
            {nav.map((n) => (
              <div key={n.href + n.label} className="group relative">
                <Link
                  href={n.href}
                  className="flex items-center gap-1.5 rounded-md px-3 py-2 text-[13.5px] font-medium text-ink transition-colors hover:bg-panel hover:text-teal-700 group-focus-within:bg-panel"
                >
                  {n.label}
                  {n.groups && (
                    <span aria-hidden className="text-[8px] text-muted transition-transform group-hover:rotate-180">
                      ▼
                    </span>
                  )}
                </Link>

                {/*
                  Deliberately no aria-expanded. The panel opens on :hover and
                  :focus-within with no JavaScript, so nothing could ever update
                  the attribute — a hard-coded aria-expanded="false" on a panel
                  that is open would actively mislead a screen reader. What is
                  offered instead is honest structure: a named group per column,
                  and every child a real link that Tab reaches in order.
                */}
                {n.groups && (
                  <div className="invisible absolute left-0 top-full z-50 pt-2 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                    <div className="rounded-xl2 border border-hair bg-white p-5 shadow-[0_18px_50px_-20px_rgba(19,41,75,0.45)]">
                      <div
                        className="grid gap-x-8 gap-y-4"
                        style={{ gridTemplateColumns: `repeat(${n.groups.length}, minmax(190px, 1fr))` }}
                      >
                        {n.groups.map((g) => (
                          <div key={g.title} role="group" aria-label={`${n.label} — ${g.title}`}>
                            <p className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-muted">
                              {g.title}
                            </p>
                            <ul className="space-y-0.5">
                              {g.links.map((l) => (
                                <li key={l.href + l.label}>
                                  <Link href={l.href} className="block rounded-md px-2 py-1.5 transition-colors hover:bg-panel">
                                    <span className="block text-[13.5px] font-medium text-navy-900">{l.label}</span>
                                    {l.note && <span className="block text-[11.5px] leading-snug text-muted">{l.note}</span>}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
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
              href="/portal/agents"
              className="rounded-lg bg-teal-600 px-4 py-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-teal-700"
            >
              Agent login
            </Link>
          </div>
        </div>

        {/* Mobile: one scrolling strip. A mega panel has nowhere to open on a
            390px screen, so its children are flattened in behind their parent
            rather than being quietly unreachable on a phone. */}
        <nav aria-label="Main menu, mobile" className="flex gap-1 overflow-x-auto border-t border-hair px-5 py-2 lg:hidden">
          {nav.flatMap((n) => [
            <Link
              key={'m' + n.href + n.label}
              href={n.href}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-panel"
            >
              {n.label}
            </Link>,
            ...(n.groups ?? []).flatMap((g) =>
              g.links.map((l) => (
                <Link
                  key={'m' + n.label + l.href + l.label}
                  href={l.href}
                  className="whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] text-muted hover:bg-panel hover:text-ink"
                >
                  {l.label}
                </Link>
              ))
            )
          ])}
        </nav>
      </header>
    </>
  );
}
