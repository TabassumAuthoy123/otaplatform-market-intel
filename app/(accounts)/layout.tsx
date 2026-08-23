import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import AccountsNav from '@/components/accounts/AccountsNav';
import { getBook } from '@/lib/accounting';
import { mayRead, signInUrl, viewer } from '@/lib/auth';
import { currentPath, enabledModules, isPathEnabled, moduleKeyFor } from '@/lib/panelMenus';

/**
 * Where the sign-in lives. The portal is the only issuer of a session, so this is
 * the only place to send somebody who has not got one.
 */
const ADMIN_URL = process.env.NEXT_PUBLIC_ADMIN_URL || process.env.ADMIN_URL || 'http://localhost:4001';

// The book is read from content/accounting.json on every request, so an edit in
// the admin portal shows on refresh.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Travel Accounts — OTA Platform | Softifybd',
  description: 'Travel and tourism accounting: sales, purchases, cash, bank, expenses, reports and statements.',
  robots: { index: false, follow: false }
};

export default async function AccountsLayout({ children }: { children: React.ReactNode }) {
  /**
   * One check for every page in the group.
   *
   * This has to be here rather than in each page. Sixteen copies of the same
   * guard is sixteen chances to add a seventeenth page and forget, and the way you
   * find out is a customer reaching a module the installation was sold without.
   * Hiding the link is not enough on its own — a bookmark, a search engine or a
   * guessed URL walks straight past a hidden link, which is exactly how the
   * storefront nav toggle ended up being half a feature.
   */
  const path = currentPath();
  if (path && !(await isPathEnabled(path))) notFound();

  /**
   * Who is asking.
   *
   * Placed here for the same reason the module guard is: one check covers every page
   * in the group, and a twenty-second page added later cannot forget it. Before
   * this, `GET /accounts/financials` with no cookie answered 200 and handed over the
   * whole book.
   *
   * The module check runs FIRST and deliberately. A module the installation does not
   * have should 404 whether or not anybody is signed in — answering "sign in to see
   * this" for a screen that does not exist tells an anonymous caller which modules
   * are switched on.
   */
  const who = viewer();
  if (!who) redirect(signInUrl('anonymous', path));

  const moduleKey = path ? moduleKeyFor(path) : null;
  if (moduleKey && !mayRead(who, moduleKey)) redirect(signInUrl('forbidden', path));

  const book = await getBook();
  /**
   * Two filters, not one, and they are different questions.
   *
   * `enabledModules` drops what this installation was not sold. This drops what this
   * person may not read. Without the second, a Sales Executive sees Financials,
   * Reports and Ledger in the nav, clicks one and is bounced to a refusal page — which
   * reads as a broken product rather than a permission, and also tells them exactly
   * what is being kept from them.
   */
  const items = (await enabledModules('accounts'))
    .filter((m) => mayRead(who, m.key))
    .map((m) => ({ href: m.href, label: m.label }));

  return (
    <>
      <AccountsNav company={book.company.name} items={items} viewer={{ name: who.name, role: who.roleLabel }} adminUrl={ADMIN_URL} />
      <main className="mx-auto w-full max-w-[1400px] px-5 pb-24 pt-8 lg:px-8">{children}</main>
      <footer className="border-t border-hair bg-white py-8 no-print">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-5 text-xs text-muted lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <p>
            <span className="font-semibold text-navy-900">{book.company.name}</span> · {book.company.address} ·{' '}
            {book.company.phone}
          </p>
          <p>Demo book — figures are generated sample data, not real trading</p>
        </div>
      </footer>
    </>
  );
}
