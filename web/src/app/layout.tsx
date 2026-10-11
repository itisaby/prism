import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'PRISM — the agent harness for MCP',
  description: 'The harness learns. The model rests.',
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#000000', viewportFit: 'cover' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // a2ui-dark pins A2UI's basic-catalog components (and form controls) to the dark theme.
    <html lang="en" className={`a2ui-dark ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
