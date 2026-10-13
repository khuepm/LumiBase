import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'My LumiBase site',
  description: 'A Next.js website powered by LumiBase.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
