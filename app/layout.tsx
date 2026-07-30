import type { Metadata } from 'next';
import './globals.css';
import Nav from '@/components/Nav';

export const metadata: Metadata = {
  title: 'OTA Platform — Bangladesh Market Intelligence | Softifybd',
  description:
    'Target customer intelligence for Softifybd OTA Platform: licensed Bangladeshi travel agencies with no OTA platform.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <Nav />
        <main className="mx-auto w-full max-w-[1400px] px-5 pb-24 pt-8 lg:px-8">{children}</main>
        <footer className="border-t border-hair bg-white py-8 no-print">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-5 text-xs text-muted lg:flex-row lg:items-center lg:justify-between lg:px-8">
            <p>
              <span className="font-semibold text-navy-900">Softifybd Limited</span> · Tower of Aakash,
              Level 18, 54 Gulshan Avenue, Dhaka 1212 · 096-12345-100
            </p>
            <p>Internal — Sales &amp; BD use only · Data captured 29 July 2026</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
