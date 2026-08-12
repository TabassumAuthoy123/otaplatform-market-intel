import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/accounts/PrintButton';
import { getBook, invoiceTotals, money } from '@/lib/accounting';
import { getContent } from '@/lib/content';
import {
  DOCUMENT_STATUS_LABEL, DOCUMENT_TYPE_LABEL, documentGross,
  documents, isMemo, linesByDocument, taxTotal
} from '@/lib/documents';

export const dynamic = 'force-dynamic';

/**
 * The passenger's copy — agency branding, their details, their ticket.
 *
 * WHY THIS IS LAST AND WHY IT TOOK A DAY RATHER THAN A WEEK
 *
 * This is the Itinerary Plus equivalent, and it is the only item on the list that
 * is purely a rendering. Every field it prints — passenger name, sectors with
 * departure times, base fare, taxes by IATA code, plating carrier, ticket number —
 * exists because of step 1 and fare capture. Before those, an invoice line held one
 * `supplierCost` number and a free-text description, and a branded document built
 * on that would have been a letterhead wrapped around a sentence.
 *
 * IT LIVES INSIDE THE PANEL, NOT ON THE STOREFRONT
 *
 * It carries a passenger's name, passport, route and fare. A public URL keyed on a
 * document id would be guessable, and the whole point of the middleware work
 * earlier was that customer data does not sit on a reachable path. So it renders
 * under `/accounts`, which is loopback-bound and behind the panel-module gate, and
 * the agency prints it or saves it as PDF and sends that.
 *
 * The same reasoning as the existing decisions on attachments and PDF: the browser's
 * print dialog rather than a second renderer to keep in step with the screen.
 *
 * IT NEVER CLAIMS A TICKET EXISTS
 *
 * `documentNo` is null on every document here, because Galileo answers NEED TICKET
 * ACCOUNT for our PCC. The header says "Booking confirmed — not yet ticketed" and
 * the reference line shows the PNR. Printing a blank where a ticket number belongs,
 * or worse inventing one, is the one thing a document like this must not do: the
 * passenger takes it to an airport counter.
 */
export default async function ItineraryPage({ params }: { params: { id: string } }) {
  const book = await getBook();
  const content = await getContent();

  const doc = documents(book).find((d) => d.id === params.id);
  if (!doc) notFound();
  // A memo is a claim against a ticket, not something a passenger is handed.
  if (isMemo(doc)) notFound();

  const ref = linesByDocument(book).get(doc.id);
  const invoice = ref?.invoice;
  const line = ref?.line;
  const totals = invoice ? invoiceTotals(invoice, book.receipts, book.creditNotes ?? []) : null;

  const c = book.company;
  const sym = c.currencySymbol;
  const brand = content.brand;

  const sold = line ? Math.round(line.unitPrice * line.qty) : null;
  const gross = documentGross(doc);
  const serviceCharge = sold !== null && gross !== null ? sold - gross : null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex flex-wrap items-center gap-2 no-print">
        <Link
          href="/accounts/documents"
          className="rounded-lg border border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900"
        >
          ← All documents
        </Link>
        {/*
          The browser's own dialog rather than a PDF library. A second renderer is a
          second thing to keep in step with the page people actually reviewed, and
          it drifts. The print stylesheet already drops the nav and the buttons.
        */}
        <PrintButton />
        <span className="text-[12px] text-muted">Print or save as PDF, then send it to the passenger.</span>
      </div>

      <article className="rounded-xl2 border border-hair bg-white px-8 py-8 shadow-card print:border-0 print:shadow-none">
        {/* ------------------------------------------------------ agency header */}
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-navy-900 pb-5">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="rounded bg-navy-900 px-2 py-1 text-[12px] font-bold tracking-wide text-white">
                {brand.logoMark}
              </span>
              <span className="text-[19px] font-bold leading-tight text-navy-900">{c.name}</span>
            </div>
            <p className="mt-2 max-w-sm text-[12px] leading-relaxed text-muted">
              {c.address}
              <br />
              {c.phone} · {c.email}
              {c.binVat ? <><br />BIN / VAT {c.binVat}</> : null}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-teal-600">Travel document</p>
            <p className="mt-1 text-[13px] text-muted">{brand.tagline}</p>
            {invoice && <p className="tnum mt-2 text-[12.5px] text-navy-900">Invoice {invoice.no}</p>}
          </div>
        </header>

        {/* ------------------------------------------------------------- status */}
        <div
          className={`mt-5 rounded-lg border-l-[3px] px-4 py-3 ${
            doc.documentNo ? 'border-teal-600 bg-teal-600/5' : 'border-amber-700 bg-amber-700/5'
          }`}
        >
          <p className="text-[13px] font-semibold text-navy-900">
            {doc.documentNo
              ? `Ticketed — document ${doc.documentNo}`
              : 'Booking confirmed — not yet ticketed'}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            {doc.documentNo
              ? 'Present this document number at check-in.'
              : `Seats are held under reference ${doc.pnr}. A ticket number will be issued separately — this document is not a ticket and cannot be used to board.`}
          </p>
        </div>

        {/* -------------------------------------------------------- who and what */}
        <section className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field label="Passenger">{doc.passengerName || invoice?.notes || '—'}</Field>
          <Field label="Booking reference (PNR)" mono>{doc.pnr || '—'}</Field>
          <Field label="Document" mono>{doc.documentNo ?? 'Not yet issued'}</Field>
          <Field label="Type">{DOCUMENT_TYPE_LABEL[doc.type]} · {DOCUMENT_STATUS_LABEL[doc.status]}</Field>
          <Field label="Airline" mono>{doc.platingCarrier || '—'}</Field>
          <Field label="Travel date" mono>{doc.travelDate ?? 'not recorded'}</Field>
        </section>

        {/* ---------------------------------------------------------- itinerary */}
        <section className="mt-7">
          <h2 className="text-[13px] font-bold uppercase tracking-wide text-navy-900">Itinerary</h2>
          {doc.sectors.length === 0 ? (
            <p className="mt-2 text-[13px] text-muted">
              No sectors were recorded on this document. The invoice describes it as:{' '}
              <span className="text-navy-900">{line?.description ?? '—'}</span>
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[420px] text-left">
                <thead>
                  <tr className="border-b border-hair">
                    {['Flight', 'From', 'To', 'Departs', 'Class'].map((h) => (
                      <th key={h} className="py-2 pr-4 text-[11px] font-bold uppercase tracking-wide text-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {doc.sectors.map((s, i) => (
                    <tr key={`${s.carrier}${s.flightNumber}-${i}`} className="border-b border-hair last:border-0">
                      <td className="tnum py-2.5 pr-4 text-[13px] font-semibold text-navy-900">{s.carrier}{s.flightNumber}</td>
                      <td className="tnum py-2.5 pr-4 text-[13px]">{s.origin}</td>
                      <td className="tnum py-2.5 pr-4 text-[13px]">{s.destination}</td>
                      <td className="tnum py-2.5 pr-4 text-[13px]">{s.departure.replace('T', ' ').slice(0, 16)}</td>
                      <td className="tnum py-2.5 text-[13px] text-muted">{s.bookingClass || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* --------------------------------------------------------------- fare */}
        <section className="mt-7">
          <h2 className="text-[13px] font-bold uppercase tracking-wide text-navy-900">Fare</h2>
          {gross === null ? (
            <p className="mt-2 text-[13px] text-muted">
              The fare breakdown was not recorded for this booking. The invoice total is{' '}
              {sold !== null ? money(sold, sym) : '—'}.
            </p>
          ) : (
            <div className="mt-2 max-w-md">
              <Row label="Base fare" value={money(doc.baseFare ?? 0, sym)} />
              {/*
                Itemised by IATA code, which is the whole reason fare capture came
                before this page. A passenger who asks why the ticket costs what it
                does gets an answer instead of one line saying "taxes".
              */}
              {doc.taxes.map((t) => (
                <Row key={t.code} label={`Tax ${t.code}`} value={money(t.amount, sym)} muted />
              ))}
              {doc.taxes.length > 0 && <Row label="Total taxes" value={money(taxTotal(doc), sym)} />}
              {serviceCharge !== null && serviceCharge !== 0 && (
                <Row label="Agency service charge" value={money(serviceCharge, sym)} />
              )}
              <div className="mt-2 border-t-2 border-navy-900 pt-2">
                <Row label="Total" value={money(sold ?? gross, sym)} bold />
              </div>
            </div>
          )}

          {totals && (
            <p className="mt-3 text-[12.5px] text-muted">
              {totals.due > 0
                ? `${money(totals.due, sym)} outstanding on invoice ${invoice!.no}.`
                : `Paid in full against invoice ${invoice!.no}.`}
            </p>
          )}
        </section>

        <footer className="mt-8 border-t border-hair pt-4 text-[11.5px] leading-relaxed text-muted">
          <p>
            Fares, taxes and schedules are as quoted by the airline at the time of booking and may change until the
            ticket is issued. Check passport, visa and health requirements for every country on your route before you
            travel. Issued by {c.name}
            {c.binVat ? `, BIN/VAT ${c.binVat}` : ''}.
          </p>
        </footer>
      </article>
    </div>
  );
}

function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10.5px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-[14px] text-navy-900 ${mono ? 'tnum' : ''}`}>{children}</div>
    </div>
  );
}

function Row({ label, value, muted = false, bold = false }: { label: string; value: string; muted?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className={`text-[13px] ${muted ? 'text-muted' : 'text-ink'} ${bold ? 'font-bold text-navy-900' : ''}`}>{label}</span>
      <span className={`tnum text-[13px] ${bold ? 'font-bold text-navy-900' : muted ? 'text-muted' : 'text-navy-900'}`}>{value}</span>
    </div>
  );
}
