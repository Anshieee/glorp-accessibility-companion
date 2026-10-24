import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Glorp — Accessibility Companion Demo',
  description:
    'Hosted hackathon demo: scan one allowlisted page with 8 selected axe rules across 6 categories. Automated subset only — not a full WCAG audit or certification.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#040208',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#040208] text-[#F3F2F7] antialiased selection:bg-[#E8FD00] selection:text-black">
        {children}
      </body>
    </html>
  );
}
