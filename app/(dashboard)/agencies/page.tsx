import { CLUSTERS, SEGMENTS } from '@/data/schema';
import AgencyTable from '@/components/AgencyTable';
import { Kicker, SectionTitle } from '@/components/ui';
import { getAgencies } from '@/lib/agencies';

// Records come from content/agencies.json, which the admin portal writes.
export const dynamic = 'force-dynamic';

export default async function AgenciesPage({
  searchParams
}: {
  searchParams: { segment?: string; cluster?: string; priority?: string; q?: string; district?: string };
}) {
  const AGENCIES = await getAgencies();
  return (
    <div>
      <Kicker>Agency database</Kicker>
      <SectionTitle sub="Every record captured from live public business listings on 29 July 2026. Click a phone number to dial. Segment reads are inferences from public signals — confirm on the call before logging.">
        {AGENCIES.length} agencies · {CLUSTERS.length} clusters
      </SectionTitle>
      <AgencyTable
        rows={AGENCIES}
        clusters={CLUSTERS}
        segments={SEGMENTS}
        initial={{
          segment: searchParams.segment ?? '',
          cluster: searchParams.cluster ?? '',
          priority: searchParams.priority ?? '',
          district: searchParams.district ?? '',
          q: searchParams.q ?? ''
        }}
      />
    </div>
  );
}
