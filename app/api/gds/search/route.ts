import { NextResponse } from 'next/server';
import { getContent } from '@/lib/content';
import { searchFlights } from '@/lib/gds';

/**
 * Flight search.
 *
 *   /api/gds/search?from=DAC&to=KUL&date=2026-09-14&adults=1
 *
 * Two halves, deliberately separate and separately labelled:
 *
 *   sample  always answers. Filters the demo routes in content/site.json so the
 *           storefront is never blank during a walkthrough. These fares are
 *           invented and the response says so.
 *
 *   live    calls Travelport. Off until the environment is configured; the
 *           response then carries the upstream status and body verbatim.
 *
 * Nothing here merges the two. A caller can always tell which fares came from
 * a GDS and which are demo data, because presenting invented fares as live
 * availability is exactly the mistake that costs an agency an account.
 */

export const dynamic = 'force-dynamic';

const code = (s: string) => {
  const m = s.match(/\(([A-Z]{3})\)/) || s.match(/\b([A-Z]{3})\b/);
  return (m ? m[1] : s).toUpperCase();
};

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const from = (p.get('from') ?? '').trim();
  const to = (p.get('to') ?? '').trim();
  const date = (p.get('date') ?? p.get('depart') ?? '').trim();
  const adults = (p.get('adults') ?? p.get('pax') ?? '1').replace(/\D/g, '') || '1';

  if (!from || !to) {
    return NextResponse.json(
      { ok: false, error: 'Both "from" and "to" are required.' },
      { status: 422 }
    );
  }

  const content = await getContent();
  const needle = to.toLowerCase();
  const origin = from.toLowerCase();

  const sample = content.routes.filter((r) => {
    const toOk = r.to.toLowerCase().includes(needle) || r.toCode.toLowerCase() === needle;
    const fromOk = !origin || origin.includes(r.from.toLowerCase()) || r.fromCode.toLowerCase() === origin;
    return toOk && fromOk;
  });

  const live = await searchFlights({ from: code(from), to: code(to), date, adults });

  return NextResponse.json({
    ok: true,
    query: { from, to, date, adults, fromCode: code(from), toCode: code(to) },
    sample: {
      note: 'Indicative demo data from content/site.json — not live availability.',
      count: sample.length,
      routes: sample
    },
    live
  });
}
