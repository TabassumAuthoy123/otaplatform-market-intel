import { NextResponse } from 'next/server';
import { CLUSTERS, SEGMENTS, CRED_LABEL, SALES_MODE_LABEL } from '@/data/schema';
import { getDataset } from '@/lib/agencies';

// Records come from content/agencies.json, which the admin portal writes.
export const dynamic = 'force-dynamic';

/**
 * GET /api/agencies
 *   ?format=csv        download the filtered call sheet
 *   ?priority=A        A | B | C | X
 *   ?segment=S1        S1..S6 (matches primary or secondary)
 *   ?cluster=paltan    cluster id
 *   ?district=Dhaka
 *   ?targetsOnly=1     exclude X records
 *   ?stats=1           return aggregate counters only
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const { agencies: AGENCIES, targets: TARGETS, stats: STATS, pipeline: PIPELINE } = await getDataset();

  if (p.get('stats')) {
    return NextResponse.json({ stats: STATS, pipeline: PIPELINE, clusters: CLUSTERS.length, segments: SEGMENTS.length });
  }

  let rows = p.get('targetsOnly') ? TARGETS : AGENCIES;
  const priority = p.get('priority');
  const segment = p.get('segment');
  const cluster = p.get('cluster');
  const district = p.get('district');

  if (priority) rows = rows.filter((a) => a.priority === priority);
  if (segment) rows = rows.filter((a) => a.segment === segment || a.segmentSecondary === segment);
  if (cluster) rows = rows.filter((a) => a.clusterId === cluster);
  if (district) rows = rows.filter((a) => a.district === district);

  if (p.get('format') === 'csv') {
    const head = [
      'ID','Agency','Cluster','District','Address','Phone','Priority','Segment','Segment2',
      'CivilAviation','IATA','IATA_No','ATAB_No','Hajj','SalesMode','HasOwnPlatform',
      'Rating','Reviews','Open247','SuggestedTier','Stage','Signal'
    ];
    const body = rows.map((a) => [
      a.id, a.name, CLUSTERS.find((c) => c.id === a.clusterId)?.name ?? '', a.district, a.address,
      a.phone ?? '', a.priority, a.segment, a.segmentSecondary ?? '',
      CRED_LABEL[a.caabLicence], CRED_LABEL[a.iata], a.iataNo ?? '', a.atabNo ?? '',
      CRED_LABEL[a.hajjLicence], SALES_MODE_LABEL[a.salesMode], a.hasOwnPlatform ? 'Yes' : 'No',
      a.rating ?? '', a.reviewCount ?? '', a.open247 ? 'Yes' : 'No',
      a.suggestedTier ?? '', a.stage, a.signal
    ]);
    const csv = [head, ...body]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    return new NextResponse('\uFEFF' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ota-target-customers-${rows.length}.csv"`
      }
    });
  }

  return NextResponse.json({ count: rows.length, data: rows });
}
