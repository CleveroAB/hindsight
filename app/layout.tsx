// Root layout (server component). Loads Schibsted Grotesk and runs the theme
// boot script before paint so a stored manual override never flashes.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { themeBootScript } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hindsight',
  description: 'Chat-driven investment-strategy backtester. Historical data only; nothing is traded.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
