import { Attachments } from '@/components/accounts/Attachments';
import { PageHead, Panel, StatusChip, Table, Td, Tile } from '@/components/accounts/ui';
import {
  LABEL, billBase, billDue, billPaid, fxOf, getBook, isForeign, money, payables, summarise
} from '@/lib/accounting';

export const dynamic = 'force-dynamic';

export default async function BillsPage() {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const all = summarise(book);
  const ap = payables(book);

  const sup = (id: string) => book.suppliers.find((s) => s.id === id)?.name ?? id;

  const rows = [...book.bills]
    .map((b) => ({ bill: b, paid: billPaid(b, book.payments) }))
    .map((r) => ({ ...r, due: billDue(r.bill, book.payments, book.creditNotes, book.supplierCreditNotes) }))
    .sort((a, b) => b.bill.date.localeCompare(a.bill.date) || b.bill.no.localeCompare(a.bill.no));

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 3 · Purchases"
        title="Supplier bookings & bills"
        sub="One bill per supplier per booking. Status follows the payment vouchers raised against it."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Billed by suppliers" value={money(all.billed, sym)} sub={`${book.bills.length} bills`} />
        <Tile label="Paid out" value={money(all.paidOut, sym)} sub={`${book.payments.length} vouchers`} />
        <Tile label="Outstanding payable" value={money(ap.total, sym)} sub={`${ap.rows.length} bills`} tone="warn" />
        <Tile label="Suppliers" value={String(book.suppliers.length)} sub="Airlines, consolidators, hotels, visa" />
      </div>

      <Panel title={`${rows.length} supplier bills`} sub="Linked back to the customer invoice they were bought for">
        <Table head={['Bill', 'Date', 'Supplier', 'For invoice', 'Amount', 'Paid', 'Due', 'Status']} right={[4, 5, 6]}>
          {rows.slice(0, 60).map(({ bill, paid, due }) => (
            <tr key={bill.id} className="hover:bg-surface">
              <Td mono className="font-semibold text-navy-900">{bill.no}</Td>
              <Td mono>{bill.date}</Td>
              <Td>{sup(bill.supplierId)}</Td>
              <Td mono className="text-muted">{book.invoices.find((i) => i.id === bill.invoiceRef)?.no ?? '—'}</Td>
              <Td right mono className="font-semibold">
                {money(billBase(bill), sym)}
                <Attachments items={bill.attachments} />
                {isForeign(bill, book.company.currency) && (
                  <div className="text-[11px] font-normal text-muted">
                    {bill.currency} {bill.amount.toLocaleString('en-IN')} @ {fxOf(bill)}
                  </div>
                )}
              </Td>
              <Td right mono>{money(paid, sym)}</Td>
              <Td right mono className={due > 0 ? 'font-semibold text-amber-700' : 'text-muted'}>{money(due, sym)}</Td>
              <Td><StatusChip value={due <= 0 ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid'} /></Td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel title="Supplier payment vouchers" sub="Newest first">
        <Table head={['Voucher', 'Date', 'Supplier', 'Against bill', 'Method', 'Amount']} right={[5]}>
          {[...book.payments].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40).map((p) => (
            <tr key={p.id} className="hover:bg-surface">
              <Td mono className="font-semibold text-navy-900">{p.no}</Td>
              <Td mono>{p.date}</Td>
              <Td>{sup(p.supplierId)}</Td>
              <Td mono className="text-muted">{book.bills.find((b) => b.id === p.billId)?.no ?? '—'}</Td>
              <Td>
                {LABEL[p.method] ?? p.method}
                {p.bankId && <span className="ml-1 text-[11px] text-muted">· {book.banks.find((b) => b.id === p.bankId)?.name}</span>}
              </Td>
              <Td right mono className="font-semibold text-amber-700">{money(p.amount, sym)}</Td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}
