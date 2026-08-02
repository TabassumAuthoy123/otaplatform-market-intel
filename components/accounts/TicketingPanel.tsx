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
 * So it runs the real call on every page load. The probe sends one TEST
 * passenger on a flight 45 days out and stores nothing.
 */
export async function TicketingPanel() {
  const status = ticketingStatus();
  const results = await probeTicketing();
  const allBlocked = results.every((r) => r.entitlementBlocked);

  return (
    <div className="rounded-xl2 border border-hair bg-white shadow-card">
      <div className="border-b border-hair px-5 py-4">
        <h2 className="text-[15px] font-bold text-navy-900">Ticketing entitlement — checked just now</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Both GDS were asked to create a PNR when this page loaded. Nothing was stored and no customer data was
          sent. Search and re-pricing already work on these same credentials, which is what makes the answers below
          about entitlement rather than about the code.
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
            <strong>At least one supplier did not give the usual entitlement refusal.</strong> Read the rows below
            rather than assuming the block still stands.
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
                {r.ok ? 'Booking accepted' : r.entitlementBlocked ? 'Entitlement blocked' : 'Unexpected answer'}
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
          <strong>Travelport</strong> — enable a booking provider for PCC {status[0].pcc ?? '3BX8'} on branch{' '}
          {process.env.GDS_BRANCH ?? 'P7251392'}, covering AirCreateReservationReq, AirTicketingReq, VoidDocumentReq
          and AirRefundReq.
        </p>
        <p className="mt-1">
          <strong>Sabre</strong> — enable booking and ticketing on PCC {status[1].pcc ?? 'S00L'}:
          /v2.5.0/passenger/records, /v1.3.0/air/ticket and the /v1/trip/orders family.
        </p>
        <p className="mt-1">
          Both are still on certification credentials. Production credentials are empty in the OTAPlatform database
          for both suppliers.
        </p>
      </div>
    </div>
  );
}
