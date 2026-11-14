import type { MetadataRoute } from "next";
import { source } from "@/lib/source";
import { versionOfUrl, withSlash } from "@/lib/versions";

export const dynamic = "force-static";

const origin = "https://geometrikks.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const latestPages = source.getPages().filter((page) => versionOfUrl(page.url) === "latest");
  return [{ url: `${origin}/` }, ...latestPages.map((page) => ({ url: `${origin}${withSlash(page.url)}` }))];
}
