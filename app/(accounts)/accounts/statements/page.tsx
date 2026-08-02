import { PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { customerLedger, getBook, money, supplierLedger } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function StatementsPage({
  searchParams
}: {
  searchParams: { kind?: string; party?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const kind = searchParams.kind === 'supplier' ? 'supplier' : 'customer';
  const list = kind === 'customer' ? book.customers : book.suppliers;
  const partyId = searchParams.party ?? list[0]?.id ?? '';
  const party = list.find((p) => p.id === partyId);

  const rows = kind === 'customer' ? customerLedger(book, partyId) : supplierLedger(book, partyId);
  const closing = rows.length ? rows[rows.length - 1].balance : 0;
  const totalDebit = rows.reduce((t, r) => t + r.debit, 0);
  const totalCredit = rows.reduce((t, r) => t + r.credit, 0);

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 8 · Statements"
        title="Party statement"
        sub="Running ledger for one customer or supplier. A positive customer balance is money owed to us; a positive supplier balance is money we owe them."
      />

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Statement of</span>
          <select name="kind" defaultValue={kind} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="customer">Customer</option>
            <option value="supplier">Supplier</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Party</span>
          <select name="party" defaultValue={partyId} className="w-64 rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            {list.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Show statement</button>
        <span className="text-[12px] text-muted">Changing party requires pressing the button — the list is a plain form, no JavaScript.</span>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Party" value={party?.name ?? '—'} sub={kind === 'customer' ? 'Customer' : 'Supplier'} />
        <Tile label="Entries" value={String(rows.length)} sub="Invoices, bills, receipts, payments" />
        <Tile label={kind === 'customer' ? 'Invoiced' : 'Paid to supplier'} value={money(totalDebit, sym)} />
        <Tile
          label="Closing balance"
          value={money(closing, sym)}
          sub={kind === 'customer' ? (closing > 0 ? 'Owed to us' : 'Settled') : closing > 0 ? 'We owe them' : 'Settled'}
          tone={closing > 0 ? 'warn' : 'good'}
        />
      </div>

      <Panel title={`${party?.name ?? ''} — statement`} sub="Oldest first, with the running balance">
        <Table head={['Date', 'Reference', 'Detail', 'Debit', 'Credit', 'Balance']} right={[3, 4, 5]}>
          {rows.map((r) => (
            <tr key={r.ref + r.date} className="hover:bg-surface">
              <Td mono>{r.date}</Td>
              <Td mono className="font-semibold text-navy-900">{r.ref}</Td>
              <Td>{r.detail}</Td>
              <Td right mono className={r.debit ? '' : 'text-muted'}>{r.debit ? money(r.debit, sym) : '—'}</Td>
              <Td right mono className={r.credit ? 'text-teal-700' : 'text-muted'}>{r.credit ? money(r.credit, sym) : '—'}</Td>
              <Td right mono className="font-semibold">{money(r.balance, sym)}</Td>
            </tr>
          ))}
          <tr className="bg-panel">
            <Td>—</Td>
            <Td>—</Td>
            <Td className="font-semibold">Totals</Td>
            <Td right mono className="font-bold">{money(totalDebit, sym)}</Td>
            <Td right mono className="font-bold">{money(totalCredit, sym)}</Td>
            <Td right mono className="font-bold">{money(closing, sym)}</Td>
          </tr>
        </Table>
      </Panel>
    </div>
  );
}
