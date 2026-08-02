import type { Metadata } from 'next';
import AccountsNav from '@/components/accounts/AccountsNav';
import { getBook } from '@/lib/accounting';

// The book is read from content/accounting.json on every request, so an edit in
// the admin portal shows on refresh.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Travel Accounts — OTA Platform | Softifybd',
  description: 'Travel and tourism accounting: sales, purchases, cash, bank, expenses, reports and statements.',
  robots: { index: false, follow: false }
};

export default async function AccountsLayout({ children }: { children: React.ReactNode }) {
  const book = await getBook();
  return (
    <>
      <AccountsNav company={book.company.name} />
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
