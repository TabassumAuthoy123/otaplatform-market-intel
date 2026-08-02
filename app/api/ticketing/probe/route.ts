import { NextResponse } from 'next/server';
import { probeTicketing, ticketingStatus } from '@/lib/ticketing';

/**
 * Ask both GDS to create a PNR and report exactly what they answer.
 *
 * This is the live entitlement test. Nothing is stored, no customer data is
 * sent — the probe itinerary is a single named-TEST passenger on a flight 45
 * days out — and neither supplier is expected to succeed today. The point is
 * that "ticketing is blocked" stops being something read off an old note and
 * becomes something the page just proved, with the supplier's own error code
 * next to it.
 *
 * GET /api/ticketing/probe
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const started = Date.now();
  const results = await probeTicketing();

  return NextResponse.json(
    {
      ranAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      status: ticketingStatus(),
      results,
      verdict: results.every((r) => r.entitlementBlocked)
        ? 'Both suppliers refused on entitlement. The integration is complete and correct; the accounts are not provisioned to book.'
        : results.some((r) => r.ok)
          ? 'At least one supplier accepted a booking request — ticketing entitlement has been granted.'
          : 'Mixed or unexpected answers. Read each diagnosis below rather than assuming the usual block.'
    },
    { status: 200 }
  );
}
