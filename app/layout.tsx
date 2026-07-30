import type { Metadata } from 'next';
import './globals.css';

/**
 * Shell only. The two route groups own their own chrome:
 *   app/(dashboard)/layout.tsx  -> Market Intelligence nav + footer
 *   app/(portal)/layout.tsx     -> B2C storefront header + footer
 */

export const metadata: Metadata = {
  title: 'OTA Platform — Bangladesh Market Intelligence | Softifybd',
  description:
    'Target customer intelligence for Softifybd OTA Platform: licensed Bangladeshi travel agencies with no OTA platform.',
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
