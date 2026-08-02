import { PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { allBankBalances, bankBook, getBook, money } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function BankPage({ searchParams }: { searchParams: { bank?: string } }) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const balances = allBankBalances(book);
  const selected = searchParams.bank ?? book.banks[0]?.id ?? '';
  const bb = bankBook(book, selected);

  type Row = { date: string; ref: string; detail: string; in: number; out: number };
  const rows: Row[] = [
    ...bb.receiptsIn.map((r) => ({
      date: r.date, ref: r.no,
      detail: `Receipt — ${book.customers.find((c) => c.id === r.customerId)?.name ?? r.customerId}`,
      in: r.amount, out: 0
    })),
    ...bb.paymentsOut.map((p) => ({
      date: p.date, ref: p.no,
      detail: `Supplier payment — ${book.suppliers.find((s) => s.id === p.supplierId)?.name ?? p.supplierId}`,
      in: 0, out: p.amount
    })),
    ...bb.expensesOut.map((e) => ({
      date: e.date, ref: e.no,
      detail: `Expense — ${book.expenseCategories.find((c) => c.id === e.categoryId)?.name ?? ''}`,
      in: 0, out: e.amount
    })),
    ...bb.refundsOut.map((c) => ({
      date: c.date, ref: c.no,
      detail: `Refund to ${book.customers.find((x) => x.id === c.customerId)?.name ?? c.customerId}`,
      in: 0, out: c.amount
    })),
    ...bb.supplierCreditsIn.map((c) => ({
      date: c.date, ref: c.no,
      detail: `Supplier credit — ${book.suppliers.find((x) => x.id === c.supplierId)?.name ?? c.supplierId}`,
      in: c.amount, out: 0
    })),
    ...bb.depositsOut.map((d) => ({
      date: d.date, ref: d.no,
      detail: `Advance to ${book.suppliers.find((x) => x.id === d.supplierId)?.name ?? d.supplierId}`,
      in: 0, out: d.amount
    })),
    ...bb.transfersIn.map((t) => ({
      date: t.date, ref: t.no,
      detail: `Cash deposited — ${t.ref}`,
      in: t.amount, out: 0
    })),
    ...bb.transfersOut.map((t) => ({
      date: t.date, ref: t.no,
      detail: `Cash withdrawn — ${t.ref}`,
      in: 0, out: t.amount
    }))
  ].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));

  let running = bb.opening;
  const withBalance = rows.map((r) => ({ ...r, balance: (running += r.in - r.out) }));

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 5 · Bank management"
        title="Bank book"
        sub="One book per account. bKash and other MFS wallets are modelled as bank accounts, because that is how the money actually behaves."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {balances.rows.map((r) => (
          <Tile key={r.bank.id} label={r.bank.name} value={money(r.closing, sym)} sub={`${r.bank.accountNo} · ${r.bank.branch}`} tone="good" />
        ))}
        <Tile label="All accounts" value={money(balances.total, sym)} sub="Combined bank position" />
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Account</span>
          <select name="bank" defaultValue={selected} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            {book.banks.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Show book</button>
      </form>

      <Panel title={bb.bank?.name ?? 'Bank'} sub={`Opening ${money(bb.opening, sym)} · in ${money(bb.totalIn, sym)} · out ${money(bb.totalOut, sym)} · closing ${money(bb.closing, sym)}`}>
        <Table head={['Date', 'Voucher', 'Detail', 'Deposit', 'Withdrawal', 'Balance']} right={[3, 4, 5]}>
          <tr className="bg-panel">
            <Td>Opening</Td>
            <Td>—</Td>
            <Td className="font-semibold">Brought forward</Td>
            <Td right>—</Td>
            <Td right>—</Td>
            <Td right mono className="font-bold">{money(bb.opening, sym)}</Td>
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
        </Table>
      </Panel>
    </div>
  );
}
