import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: {
    default: "LumiBase Marketplace — Extend your Content OS",
    template: "%s | LumiBase Marketplace",
  },
  description:
    "Browse, install, and publish extensions that give your agents new skills. SEO, analytics, media, localization, and more for the LumiBase Content OS.",
  keywords: [
    "LumiBase",
    "Content OS",
    "headless CMS",
    "extensions",
    "agent skills",
    "marketplace",
    "edge CMS",
  ],
  authors: [{ name: "LumiBase" }],
  openGraph: {
    title: "LumiBase Marketplace",
    description:
      "Browse, install, and publish extensions that give your agents new skills.",
    url: "https://marketplace.lumibase.dev",
    siteName: "LumiBase Marketplace",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LumiBase Marketplace",
    description:
      "Browse, install, and publish extensions that give your agents new skills.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen text-white antialiased">
        {/* Fixed starfield overlay */}
        <div aria-hidden className="starfield" />
        <div className="relative z-[1]">
          <Header />
          <main>{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
