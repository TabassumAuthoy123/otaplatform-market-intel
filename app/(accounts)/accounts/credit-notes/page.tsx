import Link from 'next/link';
import { Empty, PageHead, Panel, StatusChip, Table, Td, Tile } from '@/components/accounts/ui';
import {
  creditNoteReport, getBook, invoiceTotals, isRefunded, LABEL, money, summarise
} from '@/lib/accounting';

export const dynamic = 'force-dynamic';

const ADMIN = process.env.NEXT_PUBLIC_ADMIN_URL ?? 'http://127.0.0.1:4001';

const REASONS = ['', 'cancellation', 'partial_refund', 'date_change', 'overcharge', 'goodwill', 'write_off'];

export default async function CreditNotesPage({
  searchParams
}: {
  searchParams: { reason?: string; settlement?: string; q?: string; from?: string; to?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const report = creditNoteReport(book);
  const all = summarise(book);

  let rows = report.rows;
  if (searchParams.reason) rows = rows.filter((r) => r.note.reason === searchParams.reason);
  if (searchParams.settlement === 'refunded') rows = rows.filter((r) => isRefunded(r.note));
  if (searchParams.settlement === 'credit_balance') rows = rows.filter((r) => !isRefunded(r.note));
  if (searchParams.from) rows = rows.filter((r) => r.note.date >= searchParams.from!);
  if (searchParams.to) rows = rows.filter((r) => r.note.date <= searchParams.to!);
  if (searchParams.q) {
    const q = searchParams.q.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.note.no.toLowerCase().includes(q) ||
        r.customer.toLowerCase().includes(q) ||
        (r.invoice?.no ?? '').toLowerCase().includes(q) ||
        r.note.notes.toLowerCase().includes(q)
    );
  }

  const shownCredited = rows.reduce((t, r) => t + r.note.amount, 0);
  const shownRecovered = rows.reduce((t, r) => t + r.note.supplierRefund, 0);

  /** Sales reversed as a share of what was invoiced — the cancellation rate. */
  const reversalPct = all.grossSales > 0 ? (report.credited / all.grossSales) * 100 : 0;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Module 2 · Sales"
        title="Credit notes & cancellations"
        sub="Reversing a sale. A credit note either reduces what the customer still owes or sends money back out — never both, which is what stops a refund being counted twice."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Credited" value={money(report.credited, sym)} sub={`${report.rows.length} credit notes`} tone="warn" />
        <Tile label="Refunded in money" value={money(report.refunded, sym)} sub="Left cash or bank" tone="warn" />
        <Tile label="Credit on account" value={money(report.onAccount, sym)} sub="Reduced what is owed" />
        <Tile label="Recovered from suppliers" value={money(report.supplierRecovered, sym)} sub="Came off the payable" tone="good" />
        <Tile
          label="Net cost of reversals"
          value={money(report.netLoss, sym)}
          sub={`${reversalPct.toFixed(1)}% of gross sales`}
          tone={report.netLoss > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="rounded-xl2 border-l-[3px] border-teal-600 bg-white p-5 shadow-card">
        <p className="text-[13.5px] font-semibold text-navy-900">How a cancellation is recorded</p>
        <ol className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-muted">
          <li>
            <strong className="text-navy-900">1.</strong> Raise the credit note against the invoice. If the customer had
            not paid, leave settlement on <em>credit balance</em> — the receivable simply drops and no money moves.
          </li>
          <li>
            <strong className="text-navy-900">2.</strong> If they had already paid, set settlement to the method you are
            refunding by. The amount leaves cash or that bank account on the credit note&rsquo;s date.
          </li>
          <li>
            <strong className="text-navy-900">3.</strong> Put what the airline gave back in <em>supplier refund</em> and
            point it at the bill. That comes off the payable, so a cancelled ticket leaves no phantom debt to the carrier.
          </li>
          <li>
            <strong className="text-navy-900">4.</strong> A credit note for the full invoice value marks the invoice
            cancelled everywhere — it drops out of revenue, margin and the receivables chase list on the next page load.
          </li>
        </ol>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          The book refuses a credit larger than the invoice, a refund larger than what was received, and a supplier
          refund larger than what is still outstanding on the bill. Money coming back on an already-settled bill is a
          supplier deposit, not a credit note.
        </p>
        <a
          href={`${ADMIN}/books/list?col=creditNotes`}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700"
        >
          Raise a credit note in the admin portal →
        </a>
        <span className="ml-3 text-[11.5px] text-muted">Accountant, Manager or Super Admin only</span>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-xl2 border border-hair bg-white p-4 no-print">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Search</span>
          <input
            name="q"
            defaultValue={searchParams.q ?? ''}
            placeholder="credit no, invoice, customer"
            className="w-56 rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Reason</span>
          <select name="reason" defaultValue={searchParams.reason ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            {REASONS.map((r) => (
              <option key={r} value={r}>{r ? LABEL[r] ?? r : 'All reasons'}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">Settlement</span>
          <select name="settlement" defaultValue={searchParams.settlement ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500">
            <option value="">All</option>
            <option value="refunded">Refunded in money</option>
            <option value="credit_balance">Credit balance only</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">From</span>
          <input type="date" name="from" defaultValue={searchParams.from ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted">To</span>
          <input type="date" name="to" defaultValue={searchParams.to ?? ''} className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-teal-500" />
        </label>
        <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">Filter</button>
        <a href="/accounts/credit-notes" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">Reset</a>
        <a
          href={`/api/accounts/export?format=xlsx&section=creditNotes${searchParams.from ? `&from=${searchParams.from}` : ''}${searchParams.to ? `&to=${searchParams.to}` : ''}`}
          className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900 hover:border-teal-500"
        >
          Excel ↓
        </a>
      </form>

      <Panel
        title={`${rows.length} credit notes`}
        sub={
          rows.length === report.rows.length
            ? `${money(shownCredited, sym)} credited, ${money(shownRecovered, sym)} recovered from suppliers`
            : `Filtered — ${money(shownCredited, sym)} credited, ${money(shownRecovered, sym)} recovered`
        }
      >
        {rows.length === 0 ? (
          <Empty>
            {report.rows.length === 0
              ? 'No sale has been reversed yet. When one is, it appears here and comes straight off revenue.'
              : 'Nothing matches that filter.'}
          </Empty>
        ) : (
          <Table
            head={['Credit note', 'Date', 'Customer', 'Against', 'Reason', 'Settlement', 'Credited', 'Supplier refund', 'Net cost', 'Effect']}
            right={[6, 7, 8]}
          >
            {rows.map((r) => (
              <tr key={r.note.id} className="hover:bg-surface">
                <Td mono className="font-semibold text-navy-900">{r.note.no}</Td>
                <Td mono>{r.note.date}</Td>
                <Td>{r.customer}</Td>
                <Td mono className="text-muted">
                  {r.invoice ? (
                    <>
                      {r.invoice.no}
                      <div className="text-[11px]">of {money(r.invoiceTotal, sym)}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>{LABEL[r.note.reason] ?? r.note.reason}</Td>
                <Td>
                  {isRefunded(r.note) ? (
                    <>
                      <span className="font-semibold text-amber-700">Refunded</span>
                      <div className="text-[11px] text-muted">
                        {LABEL[r.note.settlement] ?? r.note.settlement}
                        {r.bank ? ` · ${r.bank.name}` : ''}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted">Credit balance</span>
                  )}
                </Td>
                <Td right mono className="font-semibold text-amber-700">{money(r.note.amount, sym)}</Td>
                <Td right mono className="text-teal-700">
                  {r.note.supplierRefund > 0 ? money(r.note.supplierRefund, sym) : '—'}
                  {r.bill && <div className="text-[11px] font-normal text-muted">{r.bill.no}</div>}
                </Td>
                <Td right mono className="font-semibold">{money(r.note.amount - r.note.supplierRefund, sym)}</Td>
                <Td>
                  {r.fullCancellation ? (
                    <StatusChip value="cancelled" />
                  ) : (
                    <span className="text-[12px] text-muted">Partial</span>
                  )}
                  {r.note.notes && <div className="mt-1 max-w-[220px] text-[11px] leading-snug text-muted">{r.note.notes}</div>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel
        title="Invoices reversed in full"
        sub="These no longer count as sales anywhere in the book — revenue, margin, the service report and the chase list all exclude them"
      >
        {report.rows.filter((r) => r.fullCancellation).length === 0 ? (
          <Empty>No invoice has been cancelled outright.</Empty>
        ) : (
          <Table head={['Invoice', 'Date', 'Customer', 'Original value', 'Credited', 'Recovered', 'Cost to us']} right={[3, 4, 5, 6]}>
            {report.rows
              .filter((r) => r.fullCancellation && r.invoice)
              .map((r) => {
                const t = invoiceTotals(r.invoice!, book.receipts, book.creditNotes);
                return (
                  <tr key={r.note.id} className="hover:bg-surface">
                    <Td mono className="font-semibold text-navy-900">
                      <Link href={`/accounts/invoices?q=${encodeURIComponent(r.invoice!.no)}`} className="hover:underline">
                        {r.invoice!.no}
                      </Link>
                    </Td>
                    <Td mono>{r.invoice!.date}</Td>
                    <Td>{r.customer}</Td>
                    <Td right mono>{money(t.total, sym)}</Td>
                    <Td right mono className="text-amber-700">{money(t.creditedAll, sym)}</Td>
                    <Td right mono className="text-teal-700">{money(r.note.supplierRefund, sym)}</Td>
                    <Td right mono className="font-semibold">{money(r.note.amount - r.note.supplierRefund, sym)}</Td>
                  </tr>
                );
              })}
          </Table>
        )}
      </Panel>
    </div>
  );
}
