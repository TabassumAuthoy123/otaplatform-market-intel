import { PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { cashBook, getBook, money } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function CashPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const { from, to } = searchParams;
  const cb = cashBook(book, from, to);

  type Row = { date: string; ref: string; detail: string; in: number; out: number };
  const rows: Row[] = [
    ...cb.receiptsIn.map((r) => ({
      date: r.date, ref: r.no,
      detail: `Receipt — ${book.customers.find((c) => c.id === r.customerId)?.name ?? r.customerId}`,
      in: r.amount, out: 0
    })),
    ...cb.paymentsOut.map((p) => ({
      date: p.date, ref: p.no,
      detail: `Supplier payment — ${book.suppliers.find((s) => s.id === p.supplierId)?.name ?? p.supplierId}`,
      in: 0, out: p.amount
    })),
    ...cb.expensesOut.map((e) => ({
      date: e.date, ref: e.no,
      detail: `Expense — ${book.expenseCategories.find((c) => c.id === e.categoryId)?.name ?? ''}`,
      in: 0, out: e.amount
    })),
    ...cb.refundsOut.map((c) => ({
      date: c.date, ref: c.no,
      detail: `Refund to ${book.customers.find((x) => x.id === c.customerId)?.name ?? c.customerId}`,
      in: 0, out: c.amount
    })),
    ...cb.supplierCreditsIn.map((c) => ({
      date: c.date, ref: c.no,
      detail: `Supplier credit — ${book.suppliers.find((x) => x.id === c.supplierId)?.name ?? c.supplierId}`,
      in: c.amount, out: 0
    })),
    ...cb.depositsOut.map((d) => ({
      date: d.date, ref: d.no,
      detail: `Advance to ${book.suppliers.find((x) => x.id === d.supplierId)?.name ?? d.supplierId}`,
      in: 0, out: d.amount
    })),
    ...cb.transfersIn.map((t) => ({
      date: t.date, ref: t.no,
      detail: `Withdrawn from ${book.banks.find((x) => x.id === t.bankId)?.name ?? t.bankId}`,
      in: t.amount, out: 0
    })),
    ...cb.transfersOut.map((t) => ({
      date: t.date, ref: t.no,
      detail: `Banked to ${book.banks.find((x) => x.id === t.bankId)?.name ?? t.bankId}`,
      in: 0, out: t.amount
    }))
  ].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));

  let running = cb.opening;
  const withBalance = rows.map((r) => ({ ...r, balance: (running += r.in - r.out) }));

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 4 · Cash management"
        title="Cash book"
        sub="Opening + receipts − payments = closing. Cash-method vouchers only; anything through a bank or bKash sits in the bank book."
      />

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">From</span>
          <input type="date" name="from" defaultValue={from ?? ''} className="tnum rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">To</span>
          <input type="date" name="to" defaultValue={to ?? ''} className="tnum rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Apply</button>
        <a href="/accounts/cash" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Whole book</a>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Opening balance" value={money(cb.opening, sym)} sub={from ? `Before ${from}` : 'Company opening cash'} />
        <Tile label="Receipts in" value={money(cb.totalIn, sym)} sub={`${cb.receiptsIn.length} receipts`} tone="good" />
        <Tile label="Payments out" value={money(cb.totalOut, sym)} sub={`${cb.paymentsOut.length} supplier · ${cb.expensesOut.length} expense`} tone="warn" />
        <Tile label="Closing balance" value={money(cb.closing, sym)} sub="Cash in hand" tone={cb.closing >= 0 ? 'good' : 'bad'} />
      </div>

      <Panel title="Cash movements" sub="Oldest first, with the running balance">
        <Table head={['Date', 'Voucher', 'Detail', 'In', 'Out', 'Balance']} right={[3, 4, 5]}>
          <tr className="bg-panel">
            <Td mono className="font-semibold">{from ?? 'Opening'}</Td>
            <Td>—</Td>
            <Td className="font-semibold">Opening balance</Td>
            <Td right>—</Td>
            <Td right>—</Td>
            <Td right mono className="font-bold">{money(cb.opening, sym)}</Td>
          </tr>
          {withBalance.map((r) => (
            <tr key={r.ref} className="hover:bg-surface">
              <Td mono>{r.date}</Td>
              <Td mono className="text-muted">{r.ref}</Td>
              <Td>{r.detail}</Td>
              <Td right mono className={r.in ? 'font-semibold text-teal-700' : 'text-muted'}>{r.in ? money(r.in, sym) : '—'}</Td>
              <Td right mono className={r.out ? 'font-semibold text-amber-700' : 'text-muted'}>{r.out ? money(r.out, sym) : '—'}</Td>
              <Td right mono className="font-semibold">{money(r.balance, sym)}</Td>
            </tr>
          ))}
          <tr className="bg-panel">
            <Td mono className="font-semibold">{to ?? 'Closing'}</Td>
            <Td>—</Td>
            <Td className="font-semibold">Closing balance</Td>
            <Td right mono className="font-semibold text-teal-700">{money(cb.totalIn, sym)}</Td>
            <Td right mono className="font-semibold text-amber-700">{money(cb.totalOut, sym)}</Td>
            <Td right mono className="font-bold">{money(cb.closing, sym)}</Td>
          </tr>
        </Table>
      </Panel>
    </div>
  );
}
