import Link from 'next/link';
import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { getBook, money, todayISO } from '@/lib/accounting';
import {
  DOCUMENT_STATUS_LABEL, DOCUMENT_TYPE_LABEL,
  documentGross, documentRows, documents, documentsByCarrier, isMemo, memoPayable,
  unbilledDocuments, unflown, unsettledDocuments
} from '@/lib/documents';

export const dynamic = 'force-dynamic';

/**
 * The airline documents behind the invoices.
 *
 * This screen exists to make one thing visible that no other screen can show: how
 * much of the book is recorded as a ticket rather than as a line of text. Where a
 * document carries a real fare and tax split it says so; where it does not, it says
 * that too, and says which number it fell back to.
 *
 * That honesty is the point. A migrated document knows its PNR and what was paid,
 * and knows nothing about the fare breakdown, because the breakdown was never
 * recorded. Showing a confident zero there would be worse than showing nothing.
 */
export default async function DocumentsPage({
  searchParams
}: {
  searchParams: { status?: string; carrier?: string; q?: string };
}) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const today = todayISO(book);

  const all = documentRows(book);
  const unbilled = unbilledDocuments(book);
  const unsettled = unsettledDocuments(book);
  const ahead = unflown(book, today);
  const carriers = documentsByCarrier(book);
  const memos = documents(book).filter(isMemo).filter((d) => d.status !== 'void');
  const memoNet = memoPayable(book).total;

  const q = (searchParams.q ?? '').trim().toLowerCase();
  const rows = all.filter((r) => {
    if (searchParams.status && r.doc.status !== searchParams.status) return false;
    if (searchParams.carrier && r.doc.platingCarrier !== searchParams.carrier) return false;
    if (!q) return true;
    return [r.doc.pnr, r.doc.documentNo, r.doc.passengerName, r.invoiceNo]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });

  const priced = all.filter((r) => documentGross(r.doc) !== null).length;
  const commission = all.reduce((t, r) => t + (r.doc.commissionAmt ?? 0), 0);

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Sub-ledger · airline documents"
        title="Tickets & documents"
        sub={
          `${all.length} document(s). This is a record of what was issued, not a second copy of the money — ` +
          `the invoice line still carries the value and still posts to the ledger.`
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Documents on the book" value={String(all.length)} sub={`${priced} with a fare breakdown recorded`} />
        <Tile
          label="Issued, not invoiced"
          value={money(unbilled.total, sym)}
          sub={`${unbilled.rows.length} document(s) — owed to a supplier, billed to nobody`}
          tone={unbilled.total > 0 ? 'warn' : 'good'}
        />
        <Tile
          label="Issued, not settled"
          value={money(unsettled.total, sym)}
          sub={`${unsettled.rows.length} not yet matched to a billing period`}
          tone={unsettled.total > 0 ? 'warn' : 'good'}
        />
        <Tile
          label="Sold but not yet flown"
          value={money(ahead.total, sym)}
          sub={`${ahead.rows.length} document(s) departing after ${today}`}
        />
      </div>

      {/*
        The measurement that decides whether the next step is worth doing, stated
        rather than assumed. If almost nothing carries a travel date there is no
        deferral to compute yet, and saying so is more useful than a screen that
        implies otherwise.
      */}
      <div className="rounded-lg border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
        <p className="text-[13px] font-semibold text-navy-900">
          {priced === 0
            ? 'No document carries a fare and tax breakdown yet.'
            : `${priced} of ${all.length} documents carry a fare and tax breakdown.`}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Documents migrated from existing invoice lines know their PNR and what was paid, and nothing else — the
          split was never recorded, so it is left empty rather than guessed. Cost for those falls back to the invoice
          line, which is the same number every other report already uses. That is why adding this table moved no
          total.{' '}
          {ahead.rows.length === 0 && all.length > 0 && (
            <>No document carries a travel date yet either, so revenue deferral has nothing to act on so far.</>
          )}
        </p>
      </div>

      {/*
        Memos on their own panel. In the main table they are all dashes — no
        invoice, no sale, no margin — and the two columns that matter for them,
        the ticket they were raised against and the reason, do not exist there at
        all. Those two are the whole point of modelling a memo as a document
        rather than as an expense line with a note.
      */}
      {memos.length > 0 && (
        <Panel
          title="Airline memos"
          sub={`${memos.length} raised · net ${money(memoNet, sym)} owed. This is the agency's own error rate, not its trading.`}
        >
          <Table head={['Memo', 'Type', 'Carrier', 'Raised', 'Against ticket', 'Why', 'Amount']} right={[6]}>
            {memos.map((d) => (
              <tr key={d.id} className="hover:bg-surface">
                <Td mono>{d.documentNo ?? d.id}</Td>
                <Td className={d.type === 'ADM' ? 'font-semibold text-amber-800' : 'text-teal-700'}>
                  {DOCUMENT_TYPE_LABEL[d.type]}
                </Td>
                <Td mono>{d.platingCarrier || '—'}</Td>
                <Td mono className="text-muted">{d.issueDate ?? '—'}</Td>
                <Td mono>{d.againstDocumentNo ?? '—'}</Td>
                <Td className="text-muted">{d.reason || '—'}</Td>
                <Td right mono className={d.type === 'ADM' ? 'font-semibold text-amber-800' : 'text-teal-700'}>
                  {d.type === 'ACM' ? '− ' : ''}{money(documentGross(d) ?? 0, sym)}
                </Td>
              </tr>
            ))}
          </Table>
          <div className="border-t border-hair px-5 py-3 text-[12px] leading-relaxed text-muted">
            A memo posts to the ledger the day it is raised — debit memos to a cost line of their own and to
            <strong> Airline memos payable</strong>, credit memos the other way. A memo you successfully dispute is
            marked voided and posts nothing, which is why winning an argument makes this number go down.
          </div>
        </Panel>
      )}

      {carriers.length > 0 && (
        <Panel title="By plating carrier" sub="Who the money is actually owed to">
          <Table head={['Carrier', 'Documents', 'Cost']} right={[1, 2]}>
            {carriers.map((c) => (
              <tr key={c.carrier} className="hover:bg-surface">
                <Td mono>{c.carrier}</Td>
                <Td right mono>{c.count}</Td>
                <Td right mono>{money(c.cost, sym)}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      <Panel
        title="Every document"
        sub={`${rows.length} shown${rows.length !== all.length ? ` of ${all.length}` : ''}`}
        actions={
          <form className="flex flex-wrap items-center gap-2">
            <input
              name="q"
              defaultValue={searchParams.q ?? ''}
              placeholder="PNR, ticket no, passenger, invoice"
              className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            />
            <select
              name="status"
              defaultValue={searchParams.status ?? ''}
              className="rounded-lg border border-hair bg-surface px-3 py-2 text-[13px] outline-none focus:border-teal-500"
            >
              <option value="">Any status</option>
              {Object.entries(DOCUMENT_STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <button className="rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-teal-700">
              Filter
            </button>
            <Link href="/accounts/documents" className="rounded-lg border border-hair px-4 py-2 text-[13px] font-semibold text-navy-900">
              Reset
            </Link>
          </form>
        }
      >
        {rows.length === 0 ? (
          <Empty>
            No documents recorded yet. Run{' '}
            <code className="rounded bg-panel px-1.5 py-0.5">node scripts/backfill-documents.mjs</code> to create them
            from the invoice lines that already carry a PNR, or add one in the admin portal.
          </Empty>
        ) : (
          <Table
            head={['Document', 'PNR', 'Type', 'Status', 'Carrier', 'Travel', 'Invoice', 'Fare + tax', 'Sold', 'Cost', 'Margin']}
            right={[7, 8, 9, 10]}
          >
            {rows.map((r) => {
              // Shown as "not recorded" rather than as a zero. A document migrated
              // from an invoice line has no fare split, and printing 0 there would
              // be a confident wrong number on a screen people quote from.
              const gross = documentGross(r.doc);
              return (
                <tr key={r.doc.id} className="hover:bg-surface">
                  <Td mono className={r.doc.documentNo ? '' : 'text-muted'}>
                    {r.doc.documentNo ?? 'not issued'}
                  </Td>
                  <Td mono>{r.doc.pnr || '—'}</Td>
                  <Td>{DOCUMENT_TYPE_LABEL[r.doc.type]}</Td>
                  <Td className={r.doc.status === 'issued' ? 'font-semibold text-teal-700' : 'text-muted'}>
                    {DOCUMENT_STATUS_LABEL[r.doc.status]}
                  </Td>
                  <Td mono>{r.doc.platingCarrier || '—'}</Td>
                  <Td mono className={r.doc.travelDate ? '' : 'text-muted'}>{r.doc.travelDate ?? 'unknown'}</Td>
                  <Td mono className="text-muted">{r.invoiceNo ?? '—'}</Td>
                  <Td right mono className={gross === null ? 'text-muted' : ''}>
                    {gross === null ? 'not recorded' : money(gross, sym)}
                  </Td>
                  <Td right mono>{r.sold === null ? '—' : money(r.sold, sym)}</Td>
                  <Td right mono>
                    {money(r.cost, sym)}
                    {r.costFrom !== 'document' && (
                      <span className="ml-1.5 text-[11px] text-muted">({r.costFrom})</span>
                    )}
                  </Td>
                  <Td right mono className={r.margin === null ? 'text-muted' : r.margin >= 0 ? 'font-semibold text-teal-700' : 'text-amber-700'}>
                    {r.margin === null ? '—' : money(r.margin, sym)}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Panel>

      <Panel
        title="What this table unlocks"
        sub="Nothing below is built yet — the document is the prerequisite for all of it"
      >
        <div className="space-y-3 px-5 py-5 text-[13px] leading-relaxed text-ink">
          <p>
            <strong>Revenue on the travel date.</strong> A ticket sold in June for an October flight is cash in June
            and revenue in October. With a <code className="rounded bg-panel px-1.5 py-0.5">travelDate</code> on the
            document, one deferred-income account and one rule in the journal builder does it.
          </p>
          <p>
            <strong>BSP reconciliation.</strong> IATA bills per reporting period against document numbers. Matching
            our book to that file needs a document number to match on — which is why this is first.
          </p>
          <p>
            <strong>ADM and ACM.</strong> An airline clawback becomes attributable to a ticket, a carrier and a cause
            instead of appearing as an unexplained expense.
          </p>
          <p>
            <strong>Real margin.</strong> {commission > 0
              ? `${money(commission, sym)} of commission is recorded so far.`
              : 'No commission is recorded yet, so margin is still only the service charge the agency added.'}{' '}
            Once fare, tax and commission are captured, margin is the commission plus the service charge rather than
            the service charge alone.
          </p>
          <p>
            <strong>Branded travel documents.</strong> The passenger name, sectors and fare are what a branded
            itinerary prints. It is a rendering of this table.
          </p>
        </div>
      </Panel>
    </div>
  );
}
