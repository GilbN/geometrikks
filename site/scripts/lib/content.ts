import { readdirSync } from "node:fs";

export function contentSlugs(versionDir: string): Set<string> {
  const slugs = new Set<string>();
  for (const entry of readdirSync(versionDir, { recursive: true, encoding: "utf8" })) {
    const parts = entry.split(/[\\/]/);
    const name = parts.pop()!;
    if (!name.endsWith(".mdx")) continue;
    const segments = parts.filter((segment) => !/^\(.+\)$/.test(segment));
    if (name !== "index.mdx") segments.push(name.slice(0, -".mdx".length));
    slugs.add(segments.join("/"));
  }
  return slugs;
}
