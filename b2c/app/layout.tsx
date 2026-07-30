import type { Metadata } from 'next';
import './globals.css';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { getContent } from '@/lib/content';

// Content is read from disk on every request so an admin edit shows on refresh.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const c = await getContent();
  return {
    title: `${c.brand.name} — ${c.brand.tagline}`,
    description: c.hero.subtitle,
    robots: { index: false, follow: false } // local demo build, never indexed
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const c = await getContent();
  return (
    <html lang="en">
      <body>
        <Header c={c} />
        <main>{children}</main>
        <Footer c={c} />
      </body>
    </html>
  );
}
