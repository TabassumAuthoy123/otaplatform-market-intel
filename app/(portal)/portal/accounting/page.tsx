import Link from 'next/link';
import { EnquiryForm } from '@/components/portal/EnquiryForm';
import { Icon, Section, SectionTitle } from '@/components/portal/ui';
import { PANEL_MODULES } from '@/lib/panelMenus';
import { ROLES, capsOf } from '@/admin/roles.js';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Travel accounting — OTA Platform | Softifybd',
  description:
    'Double-entry travel agency accounting: invoices, supplier bills, BSP reconciliation, multi-currency settlement, journal vouchers and financial statements.'
};

/**
 * What the accounting module actually contains, for somebody deciding whether to buy it.
 *
 * WHY THIS PAGE EXISTS
 *
 * The storefront sold "a full ledger" in six words on the agents page, and the
 * accounting module — twenty-one screens, a double-entry engine, BSP matching,
 * multi-currency settlement and a reconciliation that cross-checks itself — had no page
 * of its own anywhere. A prospect could not find out what was in it without being given
 * a demo login, which is the wrong order: the demo should confirm what the page already
 * said, not be the only way to learn it.
 *
 * WHY THE SCREEN LIST AND THE ROLE TABLE ARE DERIVED
 *
 * Both come from the same declarations the product runs on — `lib/panel-modules.js` and
 * `admin/roles.js`. A marketing page that lists features by hand is a page that starts
 * lying the first time a module is renamed or a capability is split, and it lies in the
 * direction of promising more than exists. Deriving it means the worst that can happen
 * is the page being terse.
 *
 * Public on purpose: no session, nothing from `content/accounting.json`, and no figure
 * from anybody's book. It describes the product, not an installation.
 */

const HIGHLIGHTS = [
  {
    icon: 'check',
    title: 'Double entry, and it proves itself',
    body:
      'Every voucher is derived twice by independent routes — control accounts walk the documents, the journal builds the postings — and the two are cross-checked on screen. A difference is shown, never rounded away. Both trial balances and the balance sheet have to meet without a plug.'
  },
  {
    icon: 'check',
    title: 'Built for how a travel agency actually trades',
    body:
      'Supplier cost sits on the invoice line, so margin is per booking rather than a month-end guess. Tickets, EMDs and memos are a document table the invoice points at, carrying fare, tax and commission itemised the way the GDS returned them.'
  },
  {
    icon: 'check',
    title: 'BSP, ADMs and the money that goes missing',
    body:
      'A BSP file is matched against the book document by document, and each row gets a verdict: matched exactly, matched on PNR with a difference, or unknown to the book. An agency debit memo is never quietly matched to a ticket to make the totals agree.'
  },
  {
    icon: 'check',
    title: 'Foreign currency, settled honestly',
    body:
      'Exchange gain and loss is recognised only when a settlement is in the same currency as the debt at a different rate. Anything else is an overpayment held as a liability — the system will not invent income out of a rounding difference.'
  },
  {
    icon: 'check',
    title: 'Journal vouchers, with the adjustment stated',
    body:
      'Depreciation, accruals, prepayments, corrections and the opening balances of the system you are leaving. A voucher touching a cross-checked account is listed as a reconciling item with its number, date, narration and author — never absorbed into a total.'
  },
  {
    icon: 'check',
    title: 'A period you can close',
    body:
      'Lock a month and every voucher type refuses to write into it, journal vouchers included. Reversals are dated when the mistake was found, so a corrected month stays a corrected month rather than silently becoming a clean one.'
  }
];

const REPORTS = [
  'Profit and loss', 'Balance sheet', 'Cash flow', 'Trial balance — two bases',
  'General ledger and ledger cards', 'Receivables and payables ageing',
  'Sales by service, with margin', 'Expenses by category',
  'Customer and supplier statements', 'Cancellations and refunds',
  'Supplier deposits and float', 'Airline memos payable',
  'Commission by carrier contract', 'Margin by branch and by consultant'
];

export default function AccountingPage() {
  const screens = PANEL_MODULES.filter((m) => m.group === 'accounts' && m.href !== '/accounts');
  const roles = Object.entries(ROLES as Record<string, { label: string; summary: string }>).map(([key, r]) => ({
    key,
    label: r.label,
    summary: r.summary,
    books: capsOf(key).filter((c: string) => c.startsWith('books_')).length
  }));

  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-teal-300">
            Included with every plan
          </div>
          <h1 className="mt-4 max-w-3xl text-[28px] font-bold leading-tight sm:text-[38px]">
            Travel accounting that closes a month, not a spreadsheet that looks like one
          </h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/70">
            {screens.length} screens, a double-entry engine that cross-checks its own figures, and the parts a
            travel agency needs that general accounting software has never had — BSP matching, agency debit memos,
            per-booking supplier cost, and settlement in the currency the supplier actually billed.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/portal/contact"
              className="rounded-lg bg-teal-500 px-5 py-2.5 text-[13.5px] font-semibold text-white hover:bg-teal-400"
            >
              See it on your own numbers
            </Link>
            <Link
              href="/portal/agents"
              className="rounded-lg border border-white/25 px-5 py-2.5 text-[13.5px] font-semibold text-white hover:border-white/50"
            >
              The whole platform
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ the six */}
      <Section tone="surface">
        <SectionTitle kicker="What makes it different" title="Six things a general ledger will not do for you" />
        <div className="grid gap-4 md:grid-cols-2">
          {HIGHLIGHTS.map((h) => (
            <div key={h.title} className="rounded-xl2 border border-hair bg-white px-5 py-5">
              <div className="flex gap-3">
                <Icon name={h.icon} className="mt-[3px] h-4 w-4 shrink-0 text-teal-600" />
                <div>
                  <h3 className="text-[15px] font-bold text-ink">{h.title}</h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{h.body}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* -------------------------------------------------------- every screen */}
      <Section>
        <SectionTitle
          kicker="Every screen"
          title={`The ${screens.length} screens your staff will use`}
          sub="Each one can be switched off for an agency that does not sell that side of the business — off means the link disappears and the page returns 404, not a hidden menu item."
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {screens.map((m) => (
            <div key={m.key} className="rounded-lg border border-hair bg-white px-4 py-3.5">
              <div className="text-[13.5px] font-bold text-ink">{m.tileLabel ?? m.label}</div>
              <p className="mt-1.5 text-[12.5px] leading-snug text-muted">{m.note}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ------------------------------------------------------------- reports */}
      <Section tone="surface">
        <div className="grid gap-10 lg:grid-cols-[1fr_380px]">
          <div>
            <SectionTitle kicker="Reports" title="Fourteen statements, and every one exports four ways" />
            <ul className="grid gap-2 sm:grid-cols-2">
              {REPORTS.map((r) => (
                <li key={r} className="flex gap-2.5 rounded-lg border border-hair bg-white px-3.5 py-2.5">
                  <Icon name="check" className="mt-[3px] h-3.5 w-3.5 shrink-0 text-teal-600" />
                  <span className="text-[13px] leading-snug text-ink">{r}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[13px] leading-relaxed text-muted">
              Excel for the accountant, Word for the owner, Markdown for a developer and CSV for the software that
              only imports CSV — all built from the same derivation, so two formats of the same report cannot
              disagree. Printing is the fifth: the browser saves the page exactly as it was reviewed.
            </p>
          </div>

          <div>
            <SectionTitle kicker="Who sees what" title="Six roles" />
            <div className="overflow-hidden rounded-xl2 border border-hair bg-white">
              {roles.map((r) => (
                <div key={r.key} className="border-b border-hair px-4 py-3 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13.5px] font-bold text-ink">{r.label}</span>
                    <span className="text-[11.5px] text-muted">{r.books} accounting rights</span>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-snug text-muted">{r.summary}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
              A Sales Executive can raise an invoice and cannot reverse one, and cannot see what you pay your
              consolidator. Checked at the route before any handler runs, not by hiding a menu item.
            </p>
          </div>
        </div>
      </Section>

      {/* --------------------------------------------------------------- what it is not */}
      <Section>
        <SectionTitle kicker="Straight answers" title="What it is not, so nobody finds out later" />
        <div className="grid gap-3 md:grid-cols-3">
          {[
            ['Not a tax filing service', 'It computes VAT, excise duty and withholding from dated rules you enter, and prints what you owe. It does not submit anything to the NBR for you.'],
            ['Not a payroll system', 'Employees exist as a master for expense attribution. Salary runs, payslips and deductions are not built.'],
            ['Not an auditor', 'It will tell you the two derivations disagree. It cannot tell you which one is right — that is still a person reading the journal.']
          ].map(([t, b]) => (
            <div key={t} className="rounded-xl2 border border-hair bg-white px-5 py-5">
              <h3 className="text-[14px] font-bold text-ink">{t}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{b}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ----------------------------------------------------------------- ask */}
      <Section tone="surface">
        <div className="grid gap-10 lg:grid-cols-[1fr_420px]">
          <div>
            <SectionTitle
              kicker="See it properly"
              title="Bring one month of your own vouchers"
              sub="Fifteen minutes. We load a month you already closed elsewhere and show you the same month here — the trial balance, the margin per booking, and the reconciliation agreeing with itself."
            />
          </div>
          <EnquiryForm />
        </div>
      </Section>
    </>
  );
}
