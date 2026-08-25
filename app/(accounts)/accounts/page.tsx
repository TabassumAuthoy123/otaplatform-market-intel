import Link from 'next/link';
import { AlertBanner } from '@/components/accounts/AlertBanner';
import { Bar, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import {
  allBankBalances, cashBook, dailyRollup, expensesByCategory, getBook, inventory, money, moneyShort,
  payables, receivables, recentTransactions, salesByService, summarise, supplierDeposits, todayISO
} from '@/lib/accounting';
import { can, mayRead, viewer } from '@/lib/auth';
import { ExportBar } from '@/components/accounts/ExportBar';
import { SavedViews } from '@/components/SavedViews';
import { enabledModules } from '@/lib/panelMenus';

/** One class string for every field, so the row cannot drift out of alignment. */
const FIELD =
  'rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] font-normal normal-case tracking-normal text-navy-900 outline-none focus:border-teal-500';

export const dynamic = 'force-dynamic';

/**
 * The quick-link tiles were a second hard-coded list of eleven, alongside the
 * sixteen in AccountsNav, and the two had already drifted — the tiles offered no
 * Bank, Statements, Masters or Settings. Now both come from the one declaration in
 * lib/panelMenus.ts, so a tile cannot outlive the module it points at and cannot
 * survive that module being switched off.
 *
 * The root is dropped: a tile on the page you are already looking at is noise.
 */
export default async function AccountsDashboard({
  searchParams
}: {
  searchParams: { q?: string; type?: string; dir?: string; from?: string; to?: string };
}) {
  const who = viewer();
  const fin = !!who && can(who.role, 'books_financials');

  /**
   * Filtered by role as well as by installation. The nav in the layout already does
   * this; the tiles are a SECOND list of the same modules and they were missed on the
   * first pass, so a Sales Executive saw Financials, Reports and General ledger as
   * tiles even though the nav had dropped them. Two renders of one list is exactly
   * the shape that hid the mobile-vs-desktop bug in AccountsNav.
   */
  const QUICK = (await enabledModules('accounts'))
    .filter((m) => m.href !== '/accounts')
    .filter((m) => !!who && mayRead(who, m.key))
    .map((m) => ({ href: m.href, label: m.tileLabel ?? m.label }));

  /**
   * The landing is the one accounting screen everybody reaches — it is the group's
   * locked entry point, so it cannot be gated by role the way Financials, Reports and
   * Ledger are. It was nevertheless showing today's profit, gross profit, the cash and
   * bank balances, and a ten-day table with a Cost and a Gross profit column: the
   * whole-business position, on the first page after sign-in.
   *
   * So the route stays open to every role and the FIGURES are what gets gated. Someone
   * without books_financials keeps what they need to do their own job — today's sales,
   * what customers owe, what suppliers are owed — and loses cost, margin and the
   * treasury position. See the note on books_financials in admin/roles.js.
   */
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const today = todayISO(book);

  const t = summarise(book, today, today);
  const all = summarise(book);
  const cash = cashBook(book);
  const banks = allBankBalances(book);
  const ar = receivables(book);
  const ap = payables(book);
  /**
   * A search, five filters and saved views, on the one screen that had none of them.
   *
   * This landing showed ten most-recent transactions and nothing else. Anybody looking
   * for a specific voucher — which is most of why an accountant opens an accounting
   * system at all — had to guess which of the twenty other screens held it. The admin
   * portal's lead list has had saved views, a search box, eight filters and four export
   * formats for months; the panel an agency's own staff use had a list of ten rows.
   *
   * Everything is derived at request time from the same `recentTransactions` the tiles
   * above use, so a filtered list and the totals over it can never disagree.
   */
  const q = (searchParams.q ?? '').trim().toLowerCase();
  const wantType = searchParams.type ?? '';
  const wantDir = searchParams.dir ?? '';
  const from = searchParams.from ?? '';
  const to = searchParams.to ?? '';
  const filtering = !!(q || wantType || wantDir || from || to);

  /**
   * The whole book when a filter is on, ten when it is not.
   *
   * A search that only looked at the ten most recent rows would answer "not found" for
   * almost every voucher in the book, which is worse than having no search at all —
   * it would be believed.
   */
  const pool = recentTransactions(book, filtering ? Number.MAX_SAFE_INTEGER : 10);
  const matches = pool.filter((r) => {
    if (wantType && r.type !== wantType) return false;
    if (wantDir && r.direction !== wantDir) return false;
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    if (q && `${r.ref} ${r.party} ${r.type}`.toLowerCase().includes(q) === false) return false;
    return true;
  });
  const recent = filtering ? matches.slice(0, 200) : matches;
  const allTypes = Array.from(new Set(recentTransactions(book, Number.MAX_SAFE_INTEGER).map((r) => r.type))).sort();
  const matchedValue = matches.reduce((t, r) => t + r.amount, 0);

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...searchParams, ...over })) if (v) p.set(k, String(v));
    const str = p.toString();
    return str ? `/accounts?${str}` : '/accounts';
  };

  const monthStart = `${today.slice(0, 7)}-01`;
  const savedViews = [
    { label: 'Everything', href: '/accounts', active: filtering === false, title: 'Clear every filter' },
    { label: 'Money in', href: qs({ dir: 'in', type: undefined }), active: wantDir === 'in' && !wantType, title: 'Invoices and customer receipts' },
    { label: 'Money out', href: qs({ dir: 'out', type: undefined }), active: wantDir === 'out' && !wantType, title: 'Supplier payments and expenses' },
    { label: 'This month', href: qs({ from: monthStart, to: today, dir: undefined, type: undefined }), active: from === monthStart && to === today, title: `${monthStart} to ${today}` },
    { label: 'Today', href: qs({ from: today, to: today, dir: undefined, type: undefined }), active: from === today && to === today, title: today }
  ];
  const days = dailyRollup(book, 10);
  const byService = salesByService(book);
  const byExpense = expensesByCategory(book);
  const inv = inventory(book);
  const dep = supplierDeposits(book);

  const maxSvc = Math.max(...byService.map((r) => r.sales), 1);
  const maxExp = Math.max(...byExpense.map((r) => r.amount), 1);

  return (
    <div className="space-y-8">
      <PageHead
        kicker="Module 1 · Dashboard"
        title="Today at a glance"
        sub={`Book covers ${book.invoices.length} invoices. "Today" is the newest date in the book — ${today}.`}
      />

      <AlertBanner />

      {/* ------------------------------------------------- find and take away */}
      <Panel
        title="Find a voucher"
        sub={
          filtering
            ? `${matches.length} match${matches.length === 1 ? '' : 'es'} across the whole book, ${money(matchedValue, sym)} in total`
            : 'Searches every invoice, receipt, supplier payment and expense in the book — not only the ten below'
        }
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <SavedViews views={savedViews} />

          <form className="flex flex-wrap items-end gap-2.5" method="get">
            <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-muted">
              Search
              <input
                name="q"
                defaultValue={searchParams.q ?? ''}
                placeholder="voucher number, customer, supplier, category"
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-muted">
              Type
              <select name="type" defaultValue={wantType} className={FIELD}>
                <option value="">Any</option>
                {allTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-muted">
              Direction
              <select name="dir" defaultValue={wantDir} className={FIELD}>
                <option value="">Either</option>
                <option value="in">Money in</option>
                <option value="out">Money out</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-muted">
              From
              <input type="date" name="from" defaultValue={from} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-bold uppercase tracking-wide text-muted">
              To
              <input type="date" name="to" defaultValue={to} className={FIELD} />
            </label>
            <button type="submit" className="rounded-lg bg-navy-900 px-4 py-2 text-[13px] font-semibold text-white hover:bg-navy-800">
              Filter
            </button>
            {filtering && (
              <Link href="/accounts" className="rounded-lg border border-hair bg-white px-4 py-2 text-[13px] font-semibold text-navy-900 hover:border-teal-500 hover:text-teal-700">
                Reset
              </Link>
            )}
          </form>

          {/*
            The DATES are handed to the export; the search term and the type are not.
            The export builds twenty-six ledgers out of the book, and narrowing all of
            them by a free-text search would quietly produce a trial balance that does
            not balance — a download that disagrees with itself is worse than one that
            ignores a filter, because nobody checks a spreadsheet against the screen.
          */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair pt-3">
            <ExportBar from={from || undefined} to={to || undefined} label="Download the book" />
            <span className="text-[11.5px] text-muted">
              {from || to
                ? `Honours the dates above — ${from || 'start'} to ${to || 'today'}. Twenty-six ledgers in one file.`
                : 'Twenty-six ledgers in one file. Set the dates above to narrow it.'}
            </span>
          </div>
        </div>
      </Panel>

      {/* -------------------------------------------------- the seven tiles */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Today's sales" value={money(t.sales, sym)} sub={`${t.invoiceCount} invoices`} />
        {fin && (
          <>
            <Tile label="Cash balance" value={money(cash.closing, sym)} sub="Opening + receipts − payments" tone="good" />
            <Tile label="Bank balance" value={money(banks.total, sym)} sub={`${book.banks.length} accounts`} tone="good" />
            <Tile label="Today's profit" value={money(t.netProfit, sym)} sub={`Gross ${money(t.grossProfit, sym)} − expenses`} tone={t.netProfit >= 0 ? 'good' : 'bad'} />
          </>
        )}
        <Tile label="Pending customer payments" value={money(ar.total, sym)} sub={`${ar.rows.length} invoices outstanding`} tone="warn" />
        <Tile label="Pending supplier payments" value={money(ap.total, sym)} sub={`${ap.rows.length} bills unpaid`} tone="warn" />
        <Tile label="Today's expenses" value={money(t.expenses, sym)} sub="All categories" />
        <Tile label="Today's collections" value={money(t.collected, sym)} sub="Receipts banked and in hand" />
      </div>

      {/* ----------------------------------------------------- quick actions */}
      <div className="flex flex-wrap gap-2">
        {QUICK.map((q) => (
          <Link
            key={q.href}
            href={q.href}
            className="rounded-lg border border-hair bg-white px-4 py-2.5 text-[13px] font-semibold text-navy-900 transition-colors hover:border-teal-500 hover:text-teal-700"
          >
            {q.label} →
          </Link>
        ))}
      </div>

      {/* --------------------------------------------------- period position */}
      <div className="grid gap-4 lg:grid-cols-4">
        <Tile label="Sales — whole book" value={moneyShort(all.sales, sym)} sub={`${all.invoiceCount} invoices`} />
        {fin && (
          <>
            <Tile label="Supplier cost" value={moneyShort(all.cost, sym)} sub="Cost of sales" />
            <Tile label="Gross profit" value={moneyShort(all.grossProfit, sym)} sub={`${all.marginPct.toFixed(1)}% margin`} tone="good" />
            <Tile label="Net profit" value={moneyShort(all.netProfit, sym)} sub={`After ${moneyShort(all.expenses, sym)} expenses`} tone={all.netProfit >= 0 ? 'good' : 'bad'} />
          </>
        )}
      </div>

      {/* ------------------------------------------------ stock & float */}
      <div className="grid gap-4 lg:grid-cols-4">
        {fin && (
          <>
            <Tile label="Unsold stock at cost" value={moneyShort(inv.totalAtRisk, sym)} sub={`${inv.rows.length} blocks committed`} tone={inv.totalAtRisk > 0 ? 'warn' : 'good'} />
            <Tile label="Margin on the shelf" value={moneyShort(inv.potential, sym)} sub="If every remaining unit sells" />
            <Tile label="Supplier float available" value={moneyShort(dep.totalAvailable, sym)} sub="What you can issue against" tone={dep.totalAvailable >= 0 ? 'good' : 'bad'} />
          </>
        )}
        <Tile label="Blocks expiring soon" value={String(inv.expiringSoon + inv.expired)} sub="Under 30 days, a third unsold" tone={inv.expiringSoon + inv.expired > 0 ? 'warn' : 'good'} />
      </div>

      {/* ------------------------------------------------ recent transactions */}
      <Panel
        title={filtering ? 'Matching transactions' : 'Recent transactions'}
        sub={
          filtering
            ? `${matches.length} found${matches.length > 200 ? ', showing the first 200' : ''} — newest first`
            : 'Newest first, across every voucher type'
        }
      >
        <Table head={['Date', 'Type', 'Reference', 'Party', 'Amount']} right={[4]}>
          {recent.map((r) => (
            <tr key={r.ref} className="hover:bg-surface">
              <Td mono>{r.date}</Td>
              <Td>{r.type}</Td>
              <Td mono className="text-muted">{r.ref}</Td>
              <Td>{r.party}</Td>
              <Td right mono className={r.direction === 'in' ? 'font-semibold text-teal-700' : 'text-amber-700'}>
                {r.direction === 'in' ? '+' : '−'}
                {money(r.amount, sym).replace('-', '')}
              </Td>
            </tr>
          ))}
        </Table>
      </Panel>

      {/* ------------------------------------------------------ daily rollup */}
      <Panel title="Last 10 days" sub="Sales, profit and closing cash per day">
        <Table
          head={fin
            ? ['Date', 'Inv', 'Sales', 'Cost', 'Gross profit', 'Expenses', 'Net', 'Cash closing']
            : ['Date', 'Inv', 'Sales']}
          right={fin ? [1, 2, 3, 4, 5, 6, 7] : [1, 2]}
        >
          {days.map((d) => (
            <tr key={d.date} className="hover:bg-surface">
              <Td mono>{d.date}</Td>
              <Td right mono>{d.invoices}</Td>
              <Td right mono>{money(d.sales, sym)}</Td>
              {fin && (
                <>
                  <Td right mono className="text-muted">{money(d.cost, sym)}</Td>
                  <Td right mono className="font-semibold text-teal-700">{money(d.grossProfit, sym)}</Td>
                  <Td right mono className="text-amber-700">{money(d.expenses, sym)}</Td>
                  <Td right mono className="font-semibold">{money(d.netProfit, sym)}</Td>
                  <Td right mono>{money(d.cashClosing, sym)}</Td>
                </>
              )}
            </tr>
          ))}
        </Table>
      </Panel>

      {/* --------------------------------------------------------- breakdowns */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Sales by service" sub="Where the revenue comes from">
          <div className="px-5 py-3">
            {byService.map((r) => (
              <Bar
                key={r.service.id}
                value={r.sales}
                max={maxSvc}
                label={r.service.name}
                amount={fin ? `${moneyShort(r.sales, sym)} · ${moneyShort(r.profit, sym)} profit` : moneyShort(r.sales, sym)}
              />
            ))}
          </div>
        </Panel>
        <Panel title="Expenses by category" sub="Where the money goes">
          <div className="px-5 py-3">
            {byExpense.map((r) => (
              <Bar key={r.category.id} value={r.amount} max={maxExp} label={r.category.name} amount={money(r.amount, sym)} />
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
