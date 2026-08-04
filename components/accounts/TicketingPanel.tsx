import { probeTicketing, ticketingStatus } from '@/lib/ticketing';

/**
 * Ask both GDS to book, right now, and print what they said.
 *
 * This panel exists because "ticketing is blocked" had been a claim in a
 * comment for weeks with nothing re-testing it. A claim about a live supplier
 * that nothing re-checks is a claim that quietly goes out of date — and the
 * day entitlement is granted, the screen that says it is blocked is the one
 * everybody is still reading.
 *
 * That is exactly what happened. This panel said Travelport was entitlement-
 * blocked on uAPI 8236, and 8236 turned out to be our own empty TargetBranch
 * and missing ProviderCode. Travelport creates real PNRs. The lesson is not
 * "re-run the check" — it did re-run, every page load — it is that the check
 * must report the supplier's answer and not a conclusion drawn from it.
 *
 * So: three states per supplier, never two. Booking accepted, refused on
 * entitlement, or failed for a reason on our side.
 */
export async function TicketingPanel() {
  const status = ticketingStatus();
  const results = await probeTicketing();
  const booked = results.filter((r) => r.ok);
  const blocked = results.filter((r) => r.entitlementBlocked);
  const ours = results.filter((r) => !r.ok && !r.entitlementBlocked);
  const allBlocked = blocked.length === results.length;
  const names = (rs: typeof results) => rs.map((r) => r.supplier).join(' and ');

  return (
    <div className="rounded-xl2 border border-hair bg-white shadow-card">
      <div className="border-b border-hair px-5 py-4">
        <h2 className="text-[15px] font-bold text-navy-900">Can we book? — checked just now</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Both GDS were asked to create a PNR when this page loaded, on a live segment from a real search. Nothing was
          stored and no customer data was sent. Creating a PNR and issuing a ticket are two separate permissions, so a
          supplier accepting the create below does <strong>not</strong> mean it will issue.
        </p>
      </div>

      <div
        className={`border-l-[3px] px-5 py-3 text-[13px] ${
          allBlocked ? 'border-amber-700 bg-amber-700/5 text-amber-800' : 'border-teal-600 bg-teal-600/5 text-teal-800'
        }`}
      >
        {allBlocked ? (
          <>
            <strong>Both suppliers refused on entitlement.</strong> The integration is complete — the requests parse,
            route and validate — and the accounts are not provisioned to book. This is an email to Sabre and
            Travelport, not a code change.
          </>
        ) : (
          <>
            {booked.length > 0 && (
              <>
                <strong className="capitalize">{names(booked)}</strong> created a real PNR — seats can be held today.
                Issuing a ticket is a separate call against a separate permission and is not proved by this.{' '}
              </>
            )}
            {blocked.length > 0 && (
              <>
                <strong className="capitalize">{names(blocked)}</strong> refused on entitlement — that one needs the
                supplier to act, not a code change.{' '}
              </>
            )}
            {ours.length > 0 && (
              <>
                <strong className="capitalize">{names(ours)}</strong> failed for a reason on our side. Read the
                diagnosis below and fix the request — do not file it as a block.
              </>
            )}
          </>
        )}
      </div>

      {results.map((r) => {
        const s = status.find((x) => x.supplier === r.supplier)!;
        return (
          <div key={r.supplier} className="border-t border-hair px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[14px] font-bold capitalize text-navy-900">{r.supplier}</span>
              <span
                className={`chip ${
                  r.ok
                    ? 'border-teal-600/30 bg-teal-600/10 text-teal-700'
                    : r.entitlementBlocked
                      ? 'border-amber-700/30 bg-amber-700/10 text-amber-700'
                      : 'border-red-600/30 bg-red-50 text-red-700'
                }`}
              >
                {r.ok ? 'PNR created' : r.entitlementBlocked ? 'Entitlement blocked' : 'Our request, not entitlement'}
              </span>
              {r.code && <span className="tnum text-[12px] font-semibold text-navy-900">{r.code}</span>}
              {r.httpStatus !== undefined && <span className="tnum text-[12px] text-muted">HTTP {r.httpStatus}</span>}
              <span className="tnum text-[12px] text-muted">{r.elapsedMs}ms</span>
              {s.pcc && <span className="tnum text-[11.5px] text-muted">PCC {s.pcc}</span>}
              <span className="tnum text-[11.5px] text-muted">
                {s.production ? 'production' : 'certification sandbox'}
              </span>
              {r.endpointHost && <span className="tnum text-[11px] text-muted">{r.endpointHost}</span>}
            </div>

            {r.supplierMessage && (
              <p className="mt-2 text-[12.5px] text-ink">
                <span className="font-semibold text-navy-900">They said:</span> {r.supplierMessage}
              </p>
            )}
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{r.diagnosis}</p>
          </div>
        );
      })}

      <div className="border-t border-hair bg-surface px-5 py-4 text-[12px] leading-relaxed text-muted">
        <p className="font-semibold text-navy-900">What has to happen for a ticket to issue</p>
        <p className="mt-1">
          <strong>Travelport</strong> — booking is already open on PCC {status[0].pcc ?? '3BX8'}. The remaining ask is a{' '}
          <strong>ticket account on the Galileo host</strong> for that PCC: AirTicketingReq reaches the host and the
          host answers NEED TICKET ACCOUNT. VoidDocumentReq and AirRefundReq follow from the same setup.
        </p>
        <p className="mt-1">
          <strong>Sabre</strong> — enable booking and ticketing on PCC {status[1].pcc ?? 'S00L'}: PassengerDetailsRQ
          (which /v1/trip/orders/createBooking calls internally), /v1.3.0/air/ticket and the /v1/trip/orders family.
        </p>
        <p className="mt-1">
          Both are still on certification credentials. Production credentials are empty in the OTAPlatform database
          for both suppliers.
        </p>
      </div>
    </div>
  );
}
