import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://lumibase.dev"),
  title: "LumiBase - Edge-Native Headless CMS",
  description: "Build lightning-fast content management at the edge. Open-source, privacy-focused, and built for modern web development.",
  keywords: ["headless CMS", "edge computing", "content management", "open source", "Cloudflare"],
  authors: [{ name: "LumiBase" }],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "LumiBase - Edge-Native Headless CMS",
    description: "Build lightning-fast content management at the edge.",
    url: "https://lumibase.dev",
    siteName: "LumiBase",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: "@lumibase",
    title: "LumiBase - Edge-Native Headless CMS",
    description: "Build lightning-fast content management at the edge.",
  },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "LumiBase",
  url: "https://lumibase.dev",
  description:
    "Edge-native headless CMS built on Cloudflare Workers. Open-source, privacy-first, and globally distributed by default.",
  sameAs: [
    "https://github.com/khuepm/lumibase",
    "https://twitter.com/lumibase",
  ],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "technical support",
    email: "contact@lumibase.dev",
    url: "https://github.com/khuepm/lumibase/issues",
  },
};

const webSiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "LumiBase",
  url: "https://lumibase.dev",
  description: "Edge-native headless CMS built on Cloudflare Workers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="llms-txt" href="https://lumibase.dev/llms.txt" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(webSiteJsonLd) }}
        />
      </head>
      <body className={inter.className}>
        <Header />
        <main className="min-h-screen">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
