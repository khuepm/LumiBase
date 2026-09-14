import type { ReactNode } from 'react';

export const metadata = {
  title: 'LumiBase Next.js Blog',
  description: 'Posts served from a LumiBase collection.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, backgroundColor: '#fff' }}>{children}</body>
    </html>
  );
}
