import { CredentialsPanel } from '@/components/accounts/CredentialsPanel';
import { PnrCheck } from '@/components/accounts/PnrCheck';
import { TicketingPanel } from '@/components/accounts/TicketingPanel';
import { PageHead, Panel } from '@/components/accounts/ui';
import { getBook } from '@/lib/accounting';
import { missingRequired } from '@/lib/credentials';

export const dynamic = 'force-dynamic';

/**
 * The variable list used to be a seven-entry array right here, and it had drifted:
 * it claimed GDS_TIMEOUT_MS defaults to 15000 (it is 20000), listed two Travelport
 * paths that are optional as required, mentioned no Sabre variable at all, and
 * omitted GDS_TARGET_BRANCH — the one whose absence made every booking answer uAPI
 * 8236 and get reported as an entitlement block for weeks. Somebody setting this
 * up from that table would have hit exactly that wall.
 *
 * It now comes from lib/credentials.ts, which is also what the checks read, so the
 * table cannot describe an environment the code does not have.
 */
export default async function GdsPage() {
  const book = await getBook();

  // a handful of real PNRs from the book, so the demo has something to click
  const pnrs = Array.from(
    new Set(book.invoices.flatMap((i) => i.lines.map((l) => l.pnr)).filter(Boolean))
  ).slice(0, 6);

  // Derived from the same declaration the table below renders, so the banner and
  // the table can never disagree about whether the environment is complete.
  const missing = missingRequired();
  const configured = missing.length === 0;

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Booking management · PNR tracking"
        title="PNR live check"
        sub="Type a record locator. The book half always answers. The GDS half only answers once credentials are in the environment."
      />

      <TicketingPanel />

      <div
        className={`rounded-lg border-l-[3px] px-5 py-4 ${
          configured ? 'border-teal-600 bg-teal-600/5' : 'border-amber-700 bg-amber-700/5'
        }`}
      >
        <p className="text-[13px] font-semibold text-navy-900">
          {configured
            ? 'GDS environment is configured — live calls will be attempted.'
            : `GDS environment is incomplete — missing ${missing.join(', ')}. Only the local half will answer.`}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Credentials live in <code className="rounded bg-panel px-1.5 py-0.5">.env</code>, which is gitignored. They are
          never written into the repository, never logged, and never sent back to the browser.
        </p>
      </div>

      <PnrCheck samplePnrs={pnrs} />

      <CredentialsPanel />

      <Panel title="Why the request shape is configurable" sub="Read this before wiring Travelport">
        <div className="space-y-3 px-5 py-5 text-[13px] leading-relaxed text-ink">
          <p>
            Travelport sells more than one API. The path and payload for a reservation lookup differ between the JSON
            APIs and the older uAPI SOAP services, and they also depend on which products your agency is provisioned
            for.
          </p>
          <p>
            Rather than hardcode a guess, this route takes the host and path from the environment, adds HTTP Basic
            auth, and hands back whatever the upstream returns — status code, body and all. Read the endpoint off your
            own Travelport API documentation, put it in{' '}
            <code className="rounded bg-panel px-1.5 py-0.5">GDS_PNR_PATH</code>, and it will work. If your product
            needs a POST with an XML envelope instead of a GET, that is a small change in{' '}
            <code className="rounded bg-panel px-1.5 py-0.5">app/api/gds/pnr/route.ts</code> and the one place to make
            it.
          </p>
          <p className="text-muted">
            One practical warning: Travelport Preprod normally requires your public IP to be whitelisted. A correct
            endpoint and correct credentials will still fail from an un-whitelisted office connection, and the error
            you see will be a transport error rather than a 401.
          </p>
        </div>
      </Panel>
    </div>
  );
}
