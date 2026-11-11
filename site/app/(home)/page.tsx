import type { Metadata, Viewport } from "next";
import { Agents } from "@/components/landing/Agents";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { CrowdSec } from "@/components/landing/CrowdSec";
import { Features } from "@/components/landing/Features";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { Install } from "@/components/landing/Install";
import { Lightbox } from "@/components/landing/Lightbox";
import { Nav } from "@/components/landing/Nav";
import { Screens } from "@/components/landing/Screens";
import { Sources } from "@/components/landing/Sources";

const title = "GeoMetrikks · Your access logs, on a live map";
const description =
  "Your reverse proxy's access log on a live map. nginx, Traefik, Caddy or Loki. Self-hosted, one Docker image.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/" },
  icons: { icon: { url: "/favicon.svg", type: "image/svg+xml" } },
  openGraph: {
    type: "website",
    siteName: "GeoMetrikks",
    title,
    description,
    url: "/",
    images: [{ url: "/og.png", width: 1280, height: 640 }],
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: "#010810" };

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "GeoMetrikks",
  url: "https://geometrikks.dev/",
  description,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Docker",
  license: "https://opensource.org/licenses/MIT",
  codeRepository: "https://github.com/GilbN/geometrikks",
};

export default function HomePage() {
  return (
    <>
      <link rel="sitemap" href="/sitemap.xml" />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Nav />
      <Hero />
      <Sources />
      <Screens />
      <Features />
      <CrowdSec />
      <Agents />
      <Install />
      <BuiltWith />
      <Footer />
      <Lightbox />
    </>
  );
}
