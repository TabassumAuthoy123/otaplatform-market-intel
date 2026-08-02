import { Empty, PageHead, Panel, StatusChip, Table, Td, Tile } from '@/components/accounts/ui';
import { getBook, invoiceTotals, isLive, LABEL, money, receivables, summarise } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

const STATUSES = ['', 'draft', 'confirmed', 'partially_paid', 'paid', 'cancelled'];

export default async function InvoicesPage({
  searchParams
}: {
  searchParams: { status?: string; customer?: string; q?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const all = summarise(book);
  const ar = receivables(book);

  const name = (id: string) => book.customers.find((c) => c.id === id)?.name ?? id;

  let rows = book.invoices.map((i) => ({ inv: i, t: invoiceTotals(i, book.receipts), customer: name(i.customerId) }));

  if (searchParams.status) rows = rows.filter((r) => r.t.effectiveStatus === searchParams.status);
  if (searchParams.customer) rows = rows.filter((r) => r.inv.customerId === searchParams.customer);
  if (searchParams.q) {
    const q = searchParams.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.inv.no.toLowerCase().includes(q) ||
        r.customer.toLowerCase().includes(q) ||
        r.inv.lines.some((l) => l.pnr.toLowerCase().includes(q) || l.description.toLowerCase().includes(q))
    );
  }
  rows.sort((a, b) => b.inv.date.localeCompare(a.inv.date) || b.inv.no.localeCompare(a.inv.no));

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 2 · Sales"
        title="Customer invoices"
        sub="Quotation → confirmed invoice → receipt. Status is derived from the receipts against each invoice, so it can never disagree with the money."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Invoiced" value={money(all.sales, sym)} sub={`${all.invoiceCount} live invoices`} />
        <Tile label="Collected" value={money(all.collected, sym)} sub={`${book.receipts.length} receipts`} tone="good" />
        <Tile label="Outstanding" value={money(ar.total, sym)} sub={`${ar.rows.length} invoices`} tone="warn" />
        <Tile label="Gross margin" value={`${all.marginPct.toFixed(1)}%`} sub={money(all.grossProfit, sym)} tone="good" />
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Search</span>
          <input
            name="q"
            defaultValue={searchParams.q ?? ''}
            placeholder="invoice no, customer, PNR"
            className="w-64 rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Status</span>
          <select name="status" defaultValue={searchParams.status ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s ? LABEL[s] : 'All'}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Customer</span>
          <select name="customer" defaultValue={searchParams.customer ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">All</option>
            {book.customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Filter</button>
        <a href="/accounts/invoices" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Reset</a>
      </form>

      <Panel title={`${rows.length} invoices`} sub="Supplier cost and margin shown per invoice — the number that actually matters on a booking">
        {rows.length === 0 ? (
          <Empty>Nothing matches that filter.</Empty>
        ) : (
          <Table head={['Invoice', 'Date', 'Customer', 'Lines / PNR', 'Total', 'Cost', 'Profit', 'Paid', 'Due', 'Status']} right={[4, 5, 6, 7, 8]}>
            {rows.map(({ inv, t, customer }) => (
              <tr key={inv.id} className={`hover:bg-surface ${!isLive(inv) ? 'opacity-60' : ''}`}>
                <Td mono className="font-semibold text-navy-900">{inv.no}</Td>
                <Td mono>{inv.date}</Td>
                <Td>{customer}</Td>
                <Td className="text-muted">
                  {inv.lines.map((l, i) => (
                    <div key={i} className="whitespace-nowrap text-[12px]">
                      {l.description}
                      {l.pnr && <span className="tnum ml-2 rounded bg-panel px-1.5 py-0.5 text-[11px] text-navy-900">{l.pnr}</span>}
                    </div>
                  ))}
                </Td>
                <Td right mono className="font-semibold">{money(t.total, sym)}</Td>
                <Td right mono className="text-muted">{money(t.cost, sym)}</Td>
                <Td right mono className="font-semibold text-teal-700">
                  {money(t.profit, sym)}
                  <div className="text-[11px] font-normal text-muted">{t.marginPct.toFixed(1)}%</div>
                </Td>
                <Td right mono>{money(t.paid, sym)}</Td>
                <Td right mono className={t.due > 0 ? 'font-semibold text-amber-700' : 'text-muted'}>{money(t.due, sym)}</Td>
                <Td><StatusChip value={t.effectiveStatus} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Customer receipts" sub="Every payment received, newest first">
        <Table head={['Receipt', 'Date', 'Customer', 'Against', 'Method', 'Amount']} right={[5]}>
          {[...book.receipts].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40).map((r) => (
            <tr key={r.id} className="hover:bg-surface">
              <Td mono className="font-semibold text-navy-900">{r.no}</Td>
              <Td mono>{r.date}</Td>
              <Td>{name(r.customerId)}</Td>
              <Td mono className="text-muted">{book.invoices.find((i) => i.id === r.invoiceId)?.no ?? '—'}</Td>
              <Td>
                {LABEL[r.method] ?? r.method}
                {r.bankId && <span className="ml-1 text-[11px] text-muted">· {book.banks.find((b) => b.id === r.bankId)?.name}</span>}
              </Td>
              <Td right mono className="font-semibold text-teal-700">{money(r.amount, sym)}</Td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
