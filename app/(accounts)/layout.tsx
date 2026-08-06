import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import AccountsNav from '@/components/accounts/AccountsNav';
import { getBook } from '@/lib/accounting';
import { currentPath, enabledModules, isPathEnabled } from '@/lib/panelMenus';

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

  const book = await getBook();
  const items = (await enabledModules('accounts')).map((m) => ({ href: m.href, label: m.label }));

  return (
    <>
      <AccountsNav company={book.company.name} items={items} />
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
