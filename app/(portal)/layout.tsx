import type { Metadata } from 'next';
import { Footer } from '@/components/portal/Footer';
import { Header } from '@/components/portal/Header';
import { fontHref, getContent, themeCss } from '@/lib/content';

// Content is read from content/site.json on every request, so an edit in the
// admin portal shows on refresh.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const c = await getContent();
  return {
    title: `${c.brand.name} — ${c.brand.tagline}`,
    description: c.hero.subtitle,
    robots: { index: false, follow: false }
  };
}

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const c = await getContent();
  const css = themeCss(c);
  const font = fontHref(c);

  return (
    <>
      {/* Repaint from the saved theme. Injected rather than compiled so the
          admin colour pickers take effect on the next page load, no rebuild. */}
      {font && <link rel="stylesheet" href={font} />}
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <Header c={c} />
      <main>{children}</main>
      <Footer c={c} />
    </>
  );
}
