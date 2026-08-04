import { NextResponse } from 'next/server';
import { probeTicketing, ticketingStatus } from '@/lib/ticketing';

/**
 * Ask both GDS to create a PNR and report exactly what they answer.
 *
 * This is the live entitlement test. Nothing is stored, no customer data is
 * sent — the probe itinerary is a single named-TEST passenger on a live segment
 * from search — and the answers are not the same for both suppliers. The point
 * is that "ticketing is blocked" stops being something read off an old note and
 * becomes something the page just proved, with the supplier's own error code
 * next to it.
 *
 * That mattered more than expected. This route reported Travelport as
 * entitlement-blocked for weeks on uAPI code 8236, and 8236 was our own missing
 * TargetBranch and ProviderCode. Travelport creates real PNRs. So a successful
 * create must NOT be reported as "ticketing entitlement granted" — creating a
 * booking and issuing a ticket are two separate permissions and on this account
 * the first is open and the second is not.
 *
 * GET /api/ticketing/probe
 */
export const dynamic = 'force-dynamic';

type ProbeResult = Awaited<ReturnType<typeof probeTicketing>>[number];

/**
 * Say what was proved, and no more than that.
 *
 * A create that succeeds proves the supplier will hold seats. It says nothing
 * about ticketing, which is a different call against a different permission.
 * The old wording here claimed ticketing was granted the moment a create
 * returned a locator, and it printed that claim against an account whose host
 * still answers NEED TICKET ACCOUNT.
 */
function verdictFor(results: ProbeResult[]): string {
  const booked = results.filter((r) => r.ok).map((r) => r.supplier);
  const blocked = results.filter((r) => r.entitlementBlocked).map((r) => r.supplier);
  const broken = results.filter((r) => !r.ok && !r.entitlementBlocked).map((r) => r.supplier);

  if (!booked.length && !broken.length) {
    return `Every supplier refused on entitlement (${blocked.join(', ')}). The integration is complete and correct; the accounts are not provisioned to book.`;
  }

  const parts: string[] = [];
  if (booked.length) {
    parts.push(
      `${booked.join(' and ')} created a real PNR — seats can be held today. Issuing a ticket is a separate permission and is not proved by this.`
    );
  }
  if (blocked.length) {
    parts.push(`${blocked.join(' and ')} refused on entitlement — that one needs the supplier to act.`);
  }
  if (broken.length) {
    parts.push(
      `${broken.join(' and ')} failed for a reason on our side, not entitlement — read the diagnosis and fix the request.`
    );
  }
  return parts.join(' ');
}

export async function GET() {
  const started = Date.now();
  const results = await probeTicketing();

  return NextResponse.json(
    {
      ranAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      status: ticketingStatus(),
      results,
      verdict: verdictFor(results)
    },
    { status: 200 }
  );
}
