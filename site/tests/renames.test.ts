import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentSlugs } from "../scripts/lib/content";
import { buildRedirects, type RedirectRule } from "../scripts/lib/redirects";

const OLD_PATHS = [
  "get-started/quickstart",
  "get-started/configuration",
  "sources/nginx",
  "sources/nginx-proxy-manager",
  "sources/traefik",
  "sources/caddy",
  "sources/loki",
  "operate/geolite2",
  "operate/authentication",
  "operate/reverse-proxy",
  "features/crowdsec",
  "features/multi-source",
  "features/cli",
  "reference/faq",
  "contribute/development",
  "reference/configuration",
  "sources/proxy-setup",
  "operate/deployment",
  "reference/api-conventions",
  "reference/changelog",
  "reference/security",
];

// The dead-link resolver follows a rename and then the next-only rule, no further.
const MAX_HOPS = 2;

const contentDir = join(import.meta.dir, "../content");
const next = contentSlugs(join(contentDir, "docs/next"));
const renames: Record<string, string> = JSON.parse(readFileSync(join(contentDir, "renames.json"), "utf8"));
const rules = buildRedirects({ latest: new Set(), next, renames });

function follow(start: string): { end: string; hops: RedirectRule[] } {
  const hops: RedirectRule[] = [];
  let current = start;
  for (;;) {
    const rule = rules.find((candidate) => candidate.from === current);
    if (!rule || hops.length > MAX_HOPS) return { end: current, hops };
    hops.push(rule);
    current = rule.to;
  }
}

describe("Starlight docs URLs", () => {
  for (const old of OLD_PATHS) {
    for (const start of [`/docs/${old}/`, `/docs/${old}`]) {
      test(`${start} lands on a next page`, () => {
        const { end, hops } = follow(start);
        expect(hops.length).toBeGreaterThan(0);
        expect(hops.length).toBeLessThanOrEqual(MAX_HOPS);
        const match = end.match(/^\/docs\/next\/(.+)\/$/);
        expect(match).not.toBeNull();
        expect(next.has(match![1])).toBe(true);
        if (Object.hasOwn(renames, old)) expect(hops[0].status).toBe(301);
      });
    }
  }
});
