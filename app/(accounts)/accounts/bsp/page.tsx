import { Empty, PageHead, Panel, Table, Td, Tile } from '@/components/accounts/ui';
import { getBook, money } from '@/lib/accounting';
import { matchToBook, parseBspCsv } from '@/lib/bsp';
import type { MatchKind } from '@/lib/bsp';
import { documents } from '@/lib/documents';

export const dynamic = 'force-dynamic';

/**
 * Reconcile a BSP billing file against the book, before the remittance date.
 *
 * Read-only. Pasting a file changes nothing — it produces a report. Settling a
 * matched document is a separate, deliberate action, because writing `settled`
 * against the wrong period is the kind of mistake that only surfaces a month later
 * when the next billing does not add up.
 *
 * The form posts to itself and the CSV arrives as a search param on a GET, so a
 * reload re-runs the same match rather than re-submitting anything. That caps the
 * practical file size, which is the trade for a page that cannot write by accident.
 */
const LABEL: Record<MatchKind, string> = {
  disputed: 'Amounts differ',
  onlyInBsp: 'Not in the book',
  provisional: 'Matched on PNR only',
  onlyInBook: 'Not on this billing',
  exact: 'Matched'
};

const TONE: Record<MatchKind, string> = {
  disputed: 'border-amber-700/30 bg-amber-700/10 text-amber-800',
  onlyInBsp: 'border-red-600/30 bg-red-50 text-red-700',
  provisional: 'border-navy-900/20 bg-panel text-muted',
  onlyInBook: 'border-amber-700/30 bg-amber-700/10 text-amber-700',
  exact: 'border-teal-600/30 bg-teal-600/10 text-teal-700'
};

export default async function BspPage({ searchParams }: { searchParams: { csv?: string } }) {
  const book = await getBook();
  const sym = book.company.currencySymbol;
  const csv = searchParams.csv ?? '';

  const parsed = csv.trim() ? parseBspCsv(csv) : null;
  const match = parsed && parsed.rows.length ? matchToBook(book, parsed.rows) : null;

  const issued = documents(book).filter((d) => d.documentNo).length;
  const total = documents(book).length;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Settlement · IATA BSP"
        title="BSP reconciliation"
        sub="Match the billing file against the book at document level, before IATA takes the net at the remittance date."
      />

      {/*
        The most important thing on this page is the sentence explaining why it
        will match nothing today. Hiding that behind an empty table would make a
        working feature look broken and an unprovisioned account look fine.
      */}
      <div className="rounded-lg border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
        <p className="text-[13px] font-semibold text-navy-900">
          {issued === 0
            ? `No document on this book has a ticket number yet — ${total} document(s), none issued.`
            : `${issued} of ${total} document(s) carry a ticket number.`}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          BSP is keyed on the document number. Galileo answers <strong>NEED TICKET ACCOUNT</strong> for PCC 3BX8, so
          nothing has been issued and a real billing file would match nothing here on that key. The matcher therefore
          also reports a weaker <strong>PNR match</strong>, labelled as provisional — a PNR is not a document number,
          and two tickets on one booking would both match it, so it is a hint and never a settlement. Everything on
          this page works the day issuing is switched on.
        </p>
      </div>

      <Panel
        title="Paste the billing file"
        sub="CSV from BSPlink or an agent billing analysis. Nothing is written — this produces a report."
      >
        <form className="space-y-3 px-5 py-5">
          <textarea
            name="csv"
            rows={7}
            defaultValue={csv}
            placeholder={'DocumentNumber,TRNC,AirlineCode,IssueDate,Currency,FareAmount,TaxAmount,CommissionAmount,AmountPayable,PNR,Period\n0571234567890,TKT,BS,2026-08-12,BDT,25900,10699,0,36599,OTA-2608-0001,2026-08-P2'}
            className="w-full rounded-lg border border-hair bg-surface px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none focus:border-teal-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button className="rounded-lg bg-teal-600 px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-teal-700">
              Match against the book
            </button>
            <a href="/accounts/bsp" className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">
              Clear
            </a>
            <span className="text-[12px] text-muted">
              Column names are matched loosely — DocumentNumber, TicketNo, TktNo and DocNo all work.
            </span>
          </div>
        </form>
      </Panel>

      {parsed && (parsed.errors.length > 0 || parsed.missing.length > 0 || parsed.unmapped.length > 0 || parsed.skipped > 0) && (
        <Panel title="What the file did and did not carry" sub="Read this before trusting the match below">
          <div className="space-y-2 px-5 py-4 text-[12.5px] leading-relaxed">
            {parsed.errors.map((e) => (
              <p key={e} className="font-semibold text-red-700">{e}</p>
            ))}
            {parsed.missing.length > 0 && (
              <p className="text-muted">
                <span className="font-semibold text-navy-900">Not present:</span> {parsed.missing.join(', ')}. A missing
                amount is read as zero, so a comparison against it means nothing.
              </p>
            )}
            {parsed.unmapped.length > 0 && (
              <p className="text-muted">
                <span className="font-semibold text-navy-900">Columns ignored:</span> {parsed.unmapped.join(', ')}.
              </p>
            )}
            {/*
              A row with no document number is dropped, and used to be dropped in silence.
              A real billing file carries them — a mis-keyed line, a subtotal the export left
              in — and the tile below then read "5 row(s) on the file" over a file with six,
              with the missing one in no total and named nowhere. An agency remits what IATA
              asks and reconciles against a figure that quietly excludes a row, which is the
              exact shape of gap this screen exists to close.
            */}
            {parsed.skipped > 0 && (
              <p className="font-semibold text-amber-700">
                {parsed.skipped} row(s) carried no document number and are not in the match or any
                total below. BSP is keyed on the document number, so there is nothing to match them
                on — but they are on the file, and the figures here are of {parsed.rows.length} rows
                out of {parsed.rows.length + parsed.skipped}.
              </p>
            )}
          </div>
        </Panel>
      )}

      {match && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="IATA will take"
              value={money(match.summary.bspNetTotal, sym)}
              sub={
                parsed!.skipped > 0
                  ? `${parsed!.rows.length} of ${parsed!.rows.length + parsed!.skipped} row(s) — ${parsed!.skipped} had no document number`
                  : `${parsed!.rows.length} row(s) on the file`
              }
            />
            <Tile
              label="Amounts in dispute"
              value={money(match.summary.disputedBy, sym)}
              sub={
                match.summary.provisionalDiff > 0
                  ? `${match.summary.disputed} confirmed · ${money(match.summary.provisionalDiff, sym)} more on PNR-only matches`
                  : `${match.summary.disputed} document(s) differ`
              }
              tone={match.summary.disputed > 0 ? 'warn' : 'good'}
            />
            <Tile
              label="Billed, not in the book"
              value={money(match.summary.unmatchedValue, sym)}
              sub={`${match.summary.onlyInBsp} document(s) — issued outside the system?`}
              tone={match.summary.onlyInBsp > 0 ? 'bad' : 'good'}
            />
            <Tile
              label="Matched cleanly"
              value={String(match.summary.exact)}
              sub={`${match.summary.provisional} more matched on PNR only`}
              tone="good"
            />
          </div>

          <Panel title="Every row" sub="Worst first — dispute and unbilled before the clean matches">
            {match.rows.length === 0 ? (
              <Empty>Nothing to compare.</Empty>
            ) : (
              <Table head={['Status', 'Document', 'PNR', 'Carrier', 'IATA takes', 'Book says', 'Difference', 'What to do']} right={[4, 5, 6]}>
                {match.rows.slice(0, 200).map((r, i) => (
                  <tr key={`${r.kind}-${r.bsp?.documentNo ?? r.doc?.id}-${i}`} className="hover:bg-surface">
                    <Td>
                      <span className={`chip ${TONE[r.kind]}`}>{LABEL[r.kind]}</span>
                    </Td>
                    <Td mono>{r.bsp?.documentNo ?? r.doc?.documentNo ?? 'not issued'}</Td>
                    <Td mono>{r.bsp?.pnr || r.doc?.pnr || '—'}</Td>
                    <Td mono>{r.bsp?.carrier || r.doc?.platingCarrier || '—'}</Td>
                    <Td right mono>{r.bspNet === null ? '—' : money(r.bspNet, sym)}</Td>
                    <Td right mono>{r.bookNet === null ? 'not recorded' : money(r.bookNet, sym)}</Td>
                    <Td right mono className={r.difference ? 'font-semibold text-amber-800' : 'text-muted'}>
                      {r.difference === null ? '—' : money(r.difference, sym)}
                    </Td>
                    <Td className="text-muted">{r.note}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Panel>
        </>
      )}

      <Panel title="What each verdict means" sub="Each one is a different action, not a different shade of the same problem">
        <div className="space-y-3 px-5 py-5 text-[13px] leading-relaxed text-ink">
          <p><strong>Amounts differ</strong> — the airline and the book disagree on what is owed. Raise it before the
            remittance date or it is taken anyway. This is what an ADM usually turns out to be.</p>
          <p><strong>Not in the book</strong> — IATA is billing a document nothing here has ever seen. Either somebody
            issued outside the system, or a document number was mistyped. The most expensive of the five.</p>
          <p><strong>Not on this billing</strong> — recorded as issued here and not billed. Unbilled, or it fell into a
            different reporting period. Worth knowing before assuming the period is settled.</p>
          <p><strong>Matched on PNR only</strong> — provisional. The book has no ticket number for that booking, so the
            join is on the PNR, and a PNR can carry more than one ticket. Confirm before settling anything against it.</p>
          <p className="text-muted">
            The fixed-width HOT file is not read yet: that layout is defined by the IATA DISH standard and inferring
            column positions from a sample would produce a parser that looks finished and misreads a tax field the day
            a row is one character longer. The matcher above does not care which reader produced the rows, so adding
            that reader later changes nothing on this page.
          </p>
        </div>
      </Panel>
    </div>
  );
}
