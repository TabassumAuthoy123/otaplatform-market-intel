import { EnquiryForm } from '@/components/EnquiryForm';
import { Section, SectionTitle } from '@/components/ui';
import { getContent } from '@/lib/content';

export const dynamic = 'force-dynamic';

export default async function ContactPage() {
  const c = await getContent();
  return (
    <>
      <section className="hero-navy text-white">
        <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
          <h1 className="text-[28px] font-bold sm:text-[38px]">{c.contact.title}</h1>
          <p className="mt-3 text-[14.5px] text-white/70">{c.contact.body}</p>
        </div>
      </section>

      <Section tone="surface">
        <div className="grid gap-10 lg:grid-cols-[1fr_420px]">
          <div>
            <SectionTitle kicker="Reach us" title="Direct lines" />
            <div className="space-y-4">
              <Row k="Hotline">
                <a
                  href={`tel:${c.contact.hotline.replace(/[^0-9+]/g, '')}`}
                  className="tnum text-[18px] font-bold text-navy-900 hover:text-teal-700"
                >
                  {c.contact.hotline}
                </a>
              </Row>
              <Row k="Email">
                <a href={`mailto:${c.contact.email}`} className="text-[15px] font-semibold text-navy-900 hover:text-teal-700">
                  {c.contact.email}
                </a>
              </Row>
              <Row k="Office">
                <span className="text-[14px] text-ink">{c.contact.address}</span>
              </Row>
            </div>
          </div>

          <div>
            <EnquiryForm />
          </div>
        </div>
      </Section>
    </>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl2 border border-hair bg-white px-5 py-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted">{k}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
