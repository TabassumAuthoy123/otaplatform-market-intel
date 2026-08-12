import { ExportBar } from '@/components/accounts/ExportBar';
import { creditSummary } from '@/lib/credit';
import { PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import {
  billBase, bookingProfit, dailyRollup, getBook, money, payables, profitAndLoss,
  receivables, salesByService, trialBalance
} from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const from = searchParams.from || undefined;
  const to = searchParams.to || undefined;
  const book = await getBook();
  const credit = creditSummary(book);
  const sym = book.company.currencySymbol;

  const pl = profitAndLoss(book, from, to);
  const tb = trialBalance(book);
  const ar = receivables(book);
  const ap = payables(book);
  const daily = dailyRollup(book, 21);
  const byService = salesByService(book, from, to);
  const top = bookingProfit(book, 12);

  const cust = (id: string) => book.customers.find((c) => c.id === id)?.name ?? id;
  const sup = (id: string) => book.suppliers.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Modules 7 & 9 · Reports"
        title="Reports"
        sub="Everything here is derived from the vouchers at request time. There are no stored totals to go stale."
      />

      <form className="no-print flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">From</span>
          <input type="date" name="from" defaultValue={from ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">To</span>
          <input type="date" name="to" defaultValue={to ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Apply period</button>
        <a href="/accounts/reports" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Whole book</a>
        <div className="ml-auto">
          <ExportBar from={from} to={to} label="Download the book" />
        </div>
      </form>

      {/* ------------------------------------------------------ profit & loss */}
      <Panel title="Profit & loss" sub={from || to ? `${from || 'start'} to ${to || 'today'}` : 'Whole book'}>
        <div className="grid gap-0 sm:grid-cols-2">
          <div className="border-b border-hair p-5 sm:border-r sm:border-b-0">
            <Row label="Gross sales" value={money(pl.grossRevenue, sym)} />
            <Row label="Less: credit notes and cancellations" value={`− ${money(pl.creditNotes, sym)}`} muted />
            <div className="my-2 border-t border-hair" />
            <Row label="Net revenue" value={money(pl.revenue, sym)} bold />
            <Row label="Less: cost of sales (supplier)" value={`− ${money(pl.costOfSales, sym)}`} muted />
            {pl.supplierRefunds > 0 && (
              <Row label="  of which recovered from suppliers" value={money(pl.supplierRefunds, sym)} muted />
            )}
            <div className="my-3 border-t border-hair" />
            <Row label="Gross profit" value={money(pl.grossProfit, sym)} bold accent />
            <Row label="Gross margin" value={`${pl.grossMarginPct.toFixed(2)}%`} muted />
            <div className="my-3 border-t border-hair" />
            <Row label="Less: operating expenses" value={`− ${money(pl.totalExpenses, sym)}`} muted />
            <div className="my-3 border-t-2 border-navy-900" />
            <Row label="Net profit" value={money(pl.netProfit, sym)} bold accent />
            <Row label="Net margin" value={`${pl.netMarginPct.toFixed(2)}%`} muted />
          </div>
          <div className="p-5">
            <h3 className="mb-3 text-[12px] font-bold uppercase tracking-wide text-muted">Expense detail</h3>
            {pl.expenseRows.map((r) => (
              <Row key={r.category.id} label={r.category.name} value={money(r.amount, sym)} />
            ))}
          </div>
        </div>
      </Panel>

      {/* ------------------------------------------------------ trial balance */}
      <Panel
        title="Trial balance"
        sub="Control-account position derived from the vouchers, not from posted journal lines. The difference below should always be zero — it is shown rather than assumed."
      >
        <div className="grid gap-0 sm:grid-cols-2">
          <div className="border-b border-hair p-5 sm:border-r sm:border-b-0">
            <h3 className="mb-3 text-[12px] font-bold uppercase tracking-wide text-muted">Debit</h3>
            {tb.debits.map((r) => <Row key={r.account} label={r.account} value={money(r.amount, sym)} />)}
            <div className="my-3 border-t-2 border-navy-900" />
            <Row label="Total debit" value={money(tb.totalDebit, sym)} bold />
          </div>
          <div className="p-5">
            <h3 className="mb-3 text-[12px] font-bold uppercase tracking-wide text-muted">Credit</h3>
            {tb.credits.map((r) => <Row key={r.account} label={r.account} value={money(r.amount, sym)} />)}
            <div className="my-3 border-t-2 border-navy-900" />
            <Row label="Total credit" value={money(tb.totalCredit, sym)} bold />
          </div>
        </div>
        <div
          className={`border-t px-5 py-3.5 ${
            tb.difference === 0 ? 'border-hair bg-teal-600/5' : 'border-amber-700 bg-amber-700/10'
          }`}
        >
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[13px] font-semibold text-navy-900">
              Difference {tb.difference === 0 ? '— in balance' : '— OUT OF BALANCE, investigate'}
            </span>
            <span className={`tnum text-[14px] font-bold ${tb.difference === 0 ? 'text-teal-700' : 'text-amber-700'}`}>
              {money(tb.difference, sym)}
            </span>
          </div>
        </div>
      </Panel>

      {/* --------------------------------------------------------- daily grid */}
      <Panel title="Daily report" sub="Last 21 days">
        <Table head={['Date', 'Invoices', 'Sales', 'Cost', 'Gross profit', 'Collected', 'Paid out', 'Expenses', 'Net']} right={[1, 2, 3, 4, 5, 6, 7, 8]}>
          {daily.map((d) => (
            <tr key={d.date} className="hover:bg-surface">
              <Td mono>{d.date}</Td>
              <Td right mono>{d.invoices}</Td>
              <Td right mono>{money(d.sales, sym)}</Td>
              <Td right mono className="text-muted">{money(d.cost, sym)}</Td>
              <Td right mono className="font-semibold text-teal-700">{money(d.grossProfit, sym)}</Td>
              <Td right mono>{money(d.collected, sym)}</Td>
              <Td right mono>{money(d.paidOut, sym)}</Td>
              <Td right mono className="text-amber-700">{money(d.expenses, sym)}</Td>
              <Td right mono className="font-semibold">{money(d.netProfit, sym)}</Td>
            </tr>
          ))}
        </Table>
      </Panel>

      {/* ------------------------------------------------------ credit control */}
      {/*
        Placed above the outstandings, because "who is over their limit" is the
        question somebody opens this page to answer and "which invoices are open"
        is how they answer it. A customer with no limit set appears with a dash
        rather than a zero — no limit and no headroom are different states, and
        printing 0 for the first would read as "no credit left".
      */}
      <Panel
        title="Credit control"
        sub={
          credit.withLimit === 0
            ? `No customer has a credit limit set yet. Add one in Masters — until then nothing is enforced.`
            : `${credit.withLimit} customer(s) on a limit · ${credit.breached.length} over it` +
              (credit.breached.length ? ` by ${money(credit.overBy, sym)}` : '')
        }
      >
        <Table head={['Customer', 'Type', 'Open invoices', 'Oldest', 'Owed now', 'Limit', 'Headroom']} right={[2, 4, 5, 6]}>
          {credit.positions.filter((p) => p.exposure > 0 || p.limit > 0).slice(0, 25).map((p) => (
            <tr key={p.customer.id} className={p.breached ? 'bg-amber-700/5' : 'hover:bg-surface'}>
              <Td className={p.breached ? 'font-semibold text-amber-800' : ''}>{p.customer.name}</Td>
              <Td className="text-muted">{p.customer.type.replace('_', ' ')}</Td>
              <Td right mono>{p.openInvoices || '—'}</Td>
              <Td mono className="text-muted">{p.oldest ?? '—'}</Td>
              <Td right mono className="font-semibold">{money(p.exposure, sym)}</Td>
              <Td right mono className={p.limit ? '' : 'text-muted'}>{p.limit ? money(p.limit, sym) : 'none set'}</Td>
              <Td right mono className={p.headroom === undefined ? 'text-muted' : p.headroom < 0 ? 'font-semibold text-amber-800' : 'text-teal-700'}>
                {p.headroom === undefined ? '—' : money(p.headroom, sym)}
              </Td>
            </tr>
          ))}
        </Table>
        <div className="border-t border-hair px-5 py-3 text-[12px] leading-relaxed text-muted">
          Exposure is the unpaid balance of every live invoice after receipts and credit notes — not the invoice
          totals. A breach is reported here and everywhere else in the accounts module; it does not block a save,
          because extending credit past your own limit is sometimes the right call. The one place it refuses is the
          self-service storefront booking, where nobody is making that judgement.
        </div>
      </Panel>

      {/* ------------------------------------------------------- outstandings */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Outstanding receivable" sub={`${ar.rows.length} invoices · ${money(ar.total, sym)}`}>
          <Table head={['Invoice', 'Customer', 'Total', 'Due']} right={[2, 3]}>
            {ar.rows.slice(0, 20).map((r) => (
              <tr key={r.inv.id} className="hover:bg-surface">
                <Td mono className="font-semibold">{r.inv.no}</Td>
                <Td>{cust(r.inv.customerId)}</Td>
                <Td right mono>{money(r.t.total, sym)}</Td>
                <Td right mono className="font-semibold text-amber-700">{money(r.t.due, sym)}</Td>
              </tr>
            ))}
          </Table>
        </Panel>

        <Panel title="Outstanding payable" sub={`${ap.rows.length} bills · ${money(ap.total, sym)}`}>
          <Table head={['Bill', 'Supplier', 'Amount', 'Due']} right={[2, 3]}>
            {ap.rows.slice(0, 20).map((r) => (
              <tr key={r.bill.id} className="hover:bg-surface">
                <Td mono className="font-semibold">{r.bill.no}</Td>
                <Td>{sup(r.bill.supplierId)}</Td>
                <Td right mono>{money(billBase(r.bill), sym)}</Td>
                <Td right mono className="font-semibold text-amber-700">{money(r.due, sym)}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>

      {/* -------------------------------------------------- commission report */}
      <Panel title="Commission / margin by service" sub="Selling price minus supplier cost, grouped by what was sold">
        <Table head={['Service', 'Lines', 'Sales', 'Supplier cost', 'Gross profit', 'Margin']} right={[1, 2, 3, 4, 5]}>
          {byService.map((r) => (
            <tr key={r.service.id} className="hover:bg-surface">
              <Td className="font-semibold text-navy-900">{r.service.name}</Td>
              <Td right mono>{r.count}</Td>
              <Td right mono>{money(r.sales, sym)}</Td>
              <Td right mono className="text-muted">{money(r.cost, sym)}</Td>
              <Td right mono className="font-semibold text-teal-700">{money(r.profit, sym)}</Td>
              <Td right mono>{r.sales > 0 ? ((r.profit / r.sales) * 100).toFixed(1) : '0.0'}%</Td>
            </tr>
          ))}
        </Table>
      </Panel>

      {/* -------------------------------------------- gross profit per booking */}
      <Panel title="Top 12 bookings by gross profit" sub="The travel-specific number: what each booking actually earned">
        <Table head={['Invoice', 'Customer', 'PNR', 'Sale', 'Cost', 'Profit', 'Margin']} right={[3, 4, 5, 6]}>
          {top.map((r) => (
            <tr key={r.invoice.id} className="hover:bg-surface">
              <Td mono className="font-semibold">{r.invoice.no}</Td>
              <Td>{r.customer}</Td>
              <Td mono className="text-muted">{r.pnrs.join(', ') || '—'}</Td>
              <Td right mono>{money(r.total, sym)}</Td>
              <Td right mono className="text-muted">{money(r.cost, sym)}</Td>
              <Td right mono className="font-semibold text-teal-700">{money(r.profit, sym)}</Td>
              <Td right mono>{r.marginPct.toFixed(1)}%</Td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}

function Row({ label, value, bold, muted, accent }: { label: string; value: string; bold?: boolean; muted?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className={`text-[13px] ${bold ? 'font-semibold text-navy-900' : muted ? 'text-muted' : 'text-ink'}`}>{label}</span>
      <span className={`tnum text-[13.5px] ${bold ? 'font-bold' : ''} ${accent ? 'text-teal-700' : muted ? 'text-muted' : 'text-navy-900'}`}>{value}</span>
    </div>
  );
}
