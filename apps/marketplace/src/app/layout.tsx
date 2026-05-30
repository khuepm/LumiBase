import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: {
    default: "LumiBase Marketplace — Discover Extensions",
    template: "%s | LumiBase Marketplace",
  },
  description:
    "Browse, search, and install extensions for the LumiBase headless CMS. Enhance your content management with SEO, analytics, media, and more.",
  keywords: [
    "LumiBase",
    "headless CMS",
    "extensions",
    "plugins",
    "marketplace",
    "edge CMS",
  ],
  authors: [{ name: "LumiBase" }],
  openGraph: {
    title: "LumiBase Marketplace",
    description:
      "Discover and install extensions for LumiBase headless CMS.",
    url: "https://marketplace.lumibase.dev",
    siteName: "LumiBase Marketplace",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LumiBase Marketplace",
    description:
      "Discover and install extensions for LumiBase headless CMS.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-surface-950 text-gray-100 antialiased">
        <Header />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
