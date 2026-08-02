import { NextResponse } from 'next/server';
import { parseSabreOffers, sabreSearch, sabreStatus } from '@/lib/sabre';

/**
 * Sabre Bargain Finder Max search.
 *
 *   /api/sabre/search?from=DAC&to=CGP&date=2026-12-01&adults=1
 *
 * Returns the parsed offers alongside the upstream status, so a caller can tell
 * "Sabre said no" apart from "Sabre said yes and we could not read it".
 */

export const dynamic = 'force-dynamic';

const code = (s: string) => {
  const m = s.match(/\(([A-Z]{3})\)/) || s.match(/\b([A-Z]{3})\b/);
  return (m ? m[1] : s).toUpperCase();
};

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const from = code((p.get('from') ?? '').trim());
  const to = code((p.get('to') ?? '').trim());
  const date = (p.get('date') ?? p.get('depart') ?? '').trim();
  const adults = (p.get('adults') ?? p.get('pax') ?? '1').replace(/\D/g, '') || '1';

  if (!from || !to || !date) {
    return NextResponse.json({ ok: false, error: 'from, to and date are all required.' }, { status: 422 });
  }

  const status = sabreStatus();
  const live = await sabreSearch({ from, to, date, adults });
  const offers = live.upstreamOk ? parseSabreOffers(live.data) : [];

  return NextResponse.json({
    ok: true,
    supplier: 'sabre',
    query: { from, to, date, adults },
    config: { configured: status.configured, production: status.production, pcc: status.pcc, missing: status.missing },
    live: {
      configured: live.configured,
      missing: live.missing,
      attempted: live.attempted,
      upstreamStatus: live.upstreamStatus,
      upstreamOk: live.upstreamOk,
      elapsedMs: live.elapsedMs,
      endpointHost: live.endpointHost,
      fault: live.fault,
      error: live.error,
      message: live.message
    },
    offerCount: offers.length,
    offers: offers.slice(0, 20)
  });
}
