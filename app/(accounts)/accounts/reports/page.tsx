import { PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import {
  bookingProfit, dailyRollup, getBook, money, payables, profitAndLoss,
  receivables, salesByService, trialBalance
} from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const book = await getBook();
  const sym = book.company.currencySymbol;

  const pl = profitAndLoss(book);
  const tb = trialBalance(book);
  const ar = receivables(book);
  const ap = payables(book);
  const daily = dailyRollup(book, 21);
  const byService = salesByService(book);
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

      {/* ------------------------------------------------------ profit & loss */}
      <Panel title="Profit & loss" sub="Whole book">
        <div className="grid gap-0 sm:grid-cols-2">
          <div className="border-b border-hair p-5 sm:border-r sm:border-b-0">
            <Row label="Revenue" value={money(pl.revenue, sym)} bold />
            <Row label="Less: cost of sales (supplier)" value={`− ${money(pl.costOfSales, sym)}`} muted />
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
                <Td right mono>{money(r.bill.amount, sym)}</Td>
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
