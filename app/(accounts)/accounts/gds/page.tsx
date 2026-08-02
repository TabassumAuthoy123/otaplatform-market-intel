import { PnrCheck } from '@/components/accounts/PnrCheck';
import { PageHead, Panel } from '@/components/accounts/ui';
import { getBook } from '@/lib/accounting';

export const dynamic = 'force-dynamic';

const ENV_VARS = [
  ['GDS_BASE_URL', 'Host only, e.g. https://api.pp.travelport.com', true],
  ['GDS_PNR_PATH', 'Path template with {locator}, e.g. /v1/reservation/{locator}', true],
  ['GDS_USERNAME', 'Your Travelport login ID', true],
  ['GDS_PASSWORD', 'Your Travelport password', true],
  ['GDS_ACCEPT', 'Accept header, defaults to application/json', false],
  ['GDS_EXTRA_HEADERS', 'JSON object of extra headers, if your product needs them', false],
  ['GDS_TIMEOUT_MS', 'Request timeout, defaults to 15000', false]
] as const;

export default async function GdsPage() {
  const book = await getBook();

  // a handful of real PNRs from the book, so the demo has something to click
  const pnrs = Array.from(
    new Set(book.invoices.flatMap((i) => i.lines.map((l) => l.pnr)).filter(Boolean))
  ).slice(0, 6);

  const configured = Boolean(process.env.GDS_BASE_URL && process.env.GDS_USERNAME && process.env.GDS_PASSWORD && process.env.GDS_PNR_PATH);

  return (
    <div className="space-y-7">
      <PageHead
        kicker="Booking management · PNR tracking"
        title="PNR live check"
        sub="Type a record locator. The book half always answers. The GDS half only answers once credentials are in the environment."
      />

      <div
        className={`rounded-lg border-l-[3px] px-5 py-4 ${
          configured ? 'border-teal-600 bg-teal-600/5' : 'border-amber-700 bg-amber-700/5'
        }`}
      >
        <p className="text-[13px] font-semibold text-navy-900">
          {configured ? 'GDS environment is configured — live calls will be attempted.' : 'GDS environment is not configured — only the local half will answer.'}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Credentials live in <code className="rounded bg-panel px-1.5 py-0.5">.env</code>, which is gitignored. They are
          never written into the repository, never logged, and never sent back to the browser.
        </p>
      </div>

      <PnrCheck samplePnrs={pnrs} />

      <Panel title="What to put in .env" sub="Copy .env.example, fill these in, restart the app">
        <table className="w-full min-w-[560px] text-left">
          <thead>
            <tr className="border-b border-hair bg-panel">
              <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">Variable</th>
              <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">Meaning</th>
              <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-muted">Required</th>
            </tr>
          </thead>
          <tbody>
            {ENV_VARS.map(([name, meaning, req]) => (
              <tr key={name}>
                <td className="tnum border-b border-hair px-4 py-2.5 text-[13px] font-semibold text-navy-900">{name}</td>
                <td className="border-b border-hair px-4 py-2.5 text-[13px] text-ink">{meaning}</td>
                <td className="border-b border-hair px-4 py-2.5 text-[13px]">
                  {req ? <span className="font-semibold text-amber-700">Yes</span> : <span className="text-muted">Optional</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

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
