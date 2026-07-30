import { Section, SectionTitle } from '@/components/portal/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function VisaPage() {
  const c = await getContent();
  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <h1 className="text-[28px] font-bold sm:text-[36px]">{c.visa.title}</h1>
          <p className="mt-3 max-w-2xl text-[14.5px] text-white/70">{c.visa.body}</p>
        </div>
      </section>

      <Section tone="surface">
        <SectionTitle kicker={`${c.visa.destinations.length} destinations`} title="Processing windows" />
        <div className="overflow-x-auto rounded-xl2 border border-hair bg-white">
          <table className="w-full min-w-[520px] text-left">
            <thead>
              <tr className="border-b border-hair bg-navy-900 text-white">
                <th className="px-5 py-3.5 text-[12px] font-bold uppercase tracking-wide">Country</th>
                <th className="px-5 py-3.5 text-[12px] font-bold uppercase tracking-wide">Visa type</th>
                <th className="px-5 py-3.5 text-[12px] font-bold uppercase tracking-wide">Typical processing</th>
              </tr>
            </thead>
            <tbody>
              {c.visa.destinations.map((d, i) => (
                <tr key={d.country} className={i % 2 === 1 ? 'bg-surface' : ''}>
                  <td className="px-5 py-3.5 text-[13.5px] font-semibold text-navy-900">{d.country}</td>
                  <td className="px-5 py-3.5 text-[13.5px] text-ink">{d.type}</td>
                  <td className="tnum px-5 py-3.5 text-[13.5px] text-ink">{d.processing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 rounded-lg border-l-[3px] border-amber-700 bg-amber-700/5 px-5 py-4">
          <p className="text-[13px] leading-relaxed text-ink">{c.visa.note}</p>
        </div>
      </Section>
    </>
  );
}
