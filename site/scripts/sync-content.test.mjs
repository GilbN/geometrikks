import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorMap, buildPages, rewriteLinks, slugify, splitReadme } from "./sync-content.mjs";

test("splits on H2 outside code fences only", () => {
  const md = "# T\nintro\n## A\na\n```nginx\n## Version 2025/07/18\n```\n## B\nb\n";
  const s = splitReadme(md);
  assert.deepEqual(
    s.map((x) => x.title),
    ["A", "B"],
  );
  assert.match(s[0].body, /## Version 2025\/07\/18/);
  assert.equal(s[1].body, "b");
});

test("slugify matches GitHub anchors for this README's headings", () => {
  assert.equal(slugify("CrowdSec integration (optional)"), "crowdsec-integration-optional");
  assert.equal(slugify("import-logs: backfill history"), "import-logs-backfill-history");
  assert.equal(slugify("PUID and PGID"), "puid-and-pgid");
});

test("rewrites docs/ links, README anchors and screenshots", () => {
  const ctx = { anchors: { "nginx-setup": "/docs/sources/nginx/" } };
  const out = rewriteLinks(
    "[a](docs/proxy-setup.md) [b](#nginx-setup) ![c](/data/screenshots/live.png) [d](docs/proxy-setup.md#nginx) [e](https://x.y/docs/z.md)",
    ctx,
  );
  assert.equal(
    out,
    "[a](/docs/sources/proxy-setup/) [b](/docs/sources/nginx/) ![c](../../../../assets/screenshots/live.png) [d](/docs/sources/proxy-setup/#nginx) [e](https://x.y/docs/z.md)",
  );
});

test("unknown anchor fails loudly", () => {
  assert.throws(() => rewriteLinks("[x](#nope)", { anchors: {} }), /nope/);
});

test("merges Quickstart and Docker image tags into one page", () => {
  const sections = [
    { title: "Quickstart", body: "q" },
    { title: "Docker image tags", body: "t" },
    { title: "FAQ", body: "f" },
  ];
  const pages = buildPages(sections);
  const qs = pages.find((p) => p.path === "get-started/quickstart");
  assert.match(qs.body, /q[\s\S]*## Docker image tags[\s\S]*t/);
  assert.equal(pages.find((p) => p.path === "reference/faq").frontmatter.title, "FAQ");
  assert.equal(pages.length, 2);
});

test("anchor map covers H2s, merged H2s and H3s", () => {
  const sections = [
    { title: "Quickstart", body: "x" },
    { title: "Docker image tags", body: "y" },
    { title: "CLI commands", body: "### import-logs: backfill history\nz" },
  ];
  const m = anchorMap(sections);
  assert.equal(m["quickstart"], "/docs/get-started/quickstart/");
  assert.equal(m["docker-image-tags"], "/docs/get-started/quickstart/#docker-image-tags");
  assert.equal(m["import-logs-backfill-history"], "/docs/features/cli/#import-logs-backfill-history");
});

test("an unmapped README section is an error, not a silent drop", () => {
  assert.throws(() => buildPages([{ title: "Brand new section", body: "" }]), /pageMap/);
});
