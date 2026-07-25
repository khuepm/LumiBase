import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const TITLE = "LumiBase — The Content Operating System";
const DESCRIPTION =
  "LumiBase is a Content Operating System: declare your content's desired state, let governed AI agents reconcile it continuously, and keep human veto. Edge-native, AI-native, open source under Apache 2.0.";

export const metadata: Metadata = {
  metadataBase: new URL("https://lumibase.dev"),
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "Content Operating System",
    "Content OS",
    "AI-native CMS",
    "headless CMS",
    "agent-operated content",
    "edge computing",
    "Cloudflare Workers",
    "open source",
  ],
  authors: [{ name: "LumiBase" }],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://lumibase.dev",
    siteName: "LumiBase",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    site: "@khuephamminh",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "LumiBase",
  url: "https://lumibase.dev",
  description:
    "LumiBase is a Content Operating System — an edge-native, AI-native headless CMS where governed agents operate content against declarative SLOs while humans set intent, taste, and accountability.",
  sameAs: [
    "https://github.com/khuepm/lumibase",
    "https://twitter.com/khuephamminh",
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
  description:
    "The Content Operating System: declare intent, agents reconcile content, humans keep the veto.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrainsMono.variable}`}>
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
      <body className={`${inter.className} text-foreground antialiased`}>
        <div className="relative z-[1]">
          <Header />
          <main className="min-h-screen">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
