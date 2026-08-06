'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export type NavItem = { href: string; label: string };

/**
 * The sixteen links used to be a const array right here.
 *
 * They now arrive as a prop because this is a client component and the on/off
 * state is a file read — see lib/panelMenus.ts. The layout filters once and passes
 * the result, which matters more than it looks: `items` is rendered TWICE below,
 * once for the desktop nav and once for the mobile menu. Filtering at the source
 * fixes both. Filtering at either render site would leave a module hidden on one
 * breakpoint and visible on the other, and the mobile one is the one nobody
 * checks.
 */
export default function AccountsNav({ company, items }: { company: string; items: NavItem[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  const item = (href: string, label: string) => {
    const active = href === '/accounts' ? path === '/accounts' : path.startsWith(href);
    return (
      <Link
        key={href}
        href={href}
        className={`whitespace-nowrap rounded px-3 py-2 text-[13px] transition-colors ${
          active ? 'bg-white/15 font-semibold text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <header className="sticky top-0 z-50 border-b border-navy-800 bg-navy-950 no-print">
      {/* way back to the dashboard — accounting lives inside it */}
      <div className="border-b border-white/10">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-5 py-1.5 lg:px-8">
          <Link href="/" className="text-[11.5px] font-semibold text-teal-300 hover:text-white">
            ← Market Intelligence
          </Link>
          <span className="text-[11px] text-white/40">{company}</span>
        </div>
      </div>

      <div className="mx-auto flex max-w-[1400px] items-center gap-1 px-5 py-2.5 lg:px-8">
        <Link href="/accounts" className="mr-4 flex flex-col leading-tight">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-teal-400">Softifybd · OTA Platform</span>
          <span className="text-[15px] font-bold text-white">Travel Accounts</span>
        </Link>

        <nav className="ml-auto hidden items-center gap-0.5 xl:flex">{items.map((i) => item(i.href, i.label))}</nav>

        <button
          onClick={() => setOpen(!open)}
          className="ml-auto rounded border border-white/20 px-3 py-1.5 text-sm text-white xl:hidden"
        >
          Menu
        </button>
      </div>

      {open && (
        <div className="border-t border-navy-800 bg-navy-900 px-5 py-3 xl:hidden">
          <div className="flex flex-wrap gap-1">{items.map((i) => item(i.href, i.label))}</div>
        </div>
      )}
    </header>
  );
}
