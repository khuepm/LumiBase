import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "LumiBase - Edge-Native Headless CMS",
  description: "Build lightning-fast content management at the edge. Open-source, privacy-focused, and built for modern web development.",
  keywords: ["headless CMS", "edge computing", "content management", "open source", "Cloudflare"],
  authors: [{ name: "LumiBase" }],
  openGraph: {
    title: "LumiBase - Edge-Native Headless CMS",
    description: "Build lightning-fast content management at the edge.",
    url: "https://lumibase.dev",
    siteName: "LumiBase",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LumiBase - Edge-Native Headless CMS",
    description: "Build lightning-fast content management at the edge.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="llms-txt" href="https://docs.lumibase.dev/llms.txt" />
      </head>
      <body className={inter.className}>
        <Header />
        <main className="min-h-screen">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
