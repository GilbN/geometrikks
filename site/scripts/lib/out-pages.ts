import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NEXT } from "../../lib/versions";

export function exportedPages(outDir: string): { latest: Set<string>; next: Set<string> } {
  const latest = new Set<string>();
  const next = new Set<string>();
  const entries = readdirSync(join(outDir, "docs"), { recursive: true, encoding: "utf8" });
  for (const entry of entries) {
    const parts = entry.split(/[\\/]/);
    if (parts.at(-1) !== "index.html") continue;
    const slugParts = parts.slice(0, -1);
    if (slugParts[0] === NEXT) next.add(slugParts.slice(1).join("/"));
    else latest.add(slugParts.join("/"));
  }
  return { latest, next };
}
