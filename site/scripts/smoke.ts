import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type SmokeCase = {
  path: string;
  status: number;
  location?: string;
  contains?: string[];
  absent?: string[];
  scope?: "article";
  headers?: Record<string, string>;
};

const casesFile = process.argv[2];
if (!casesFile) {
  console.error("usage: bun scripts/smoke.ts <cases.json>");
  process.exit(2);
}
const cases: SmokeCase[] = JSON.parse(readFileSync(resolve(casesFile), "utf8"));
const port = process.env.SMOKE_PORT ?? "8788";
const base = `http://127.0.0.1:${port}`;
const siteRoot = resolve(import.meta.dir, "..");

function elementSpan(html: string, tag: string, openTag: RegExp): [number, number] | null {
  const open = openTag.exec(html);
  if (!open) return null;
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tags.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return [open.index, match.index + match[0].length];
  }
  return null;
}

function removeElements(html: string, tag: string): string {
  const openTag = new RegExp(`<${tag}\\b[^>]*>`, "i");
  let rest = html;
  for (let span = elementSpan(rest, tag, openTag); span; span = elementSpan(rest, tag, openTag)) {
    rest = rest.slice(0, span[0]) + rest.slice(span[1]);
  }
  return rest;
}

function mainArticle(html: string): string | null {
  const span = elementSpan(html, "article", /<article\b[^>]*\bid="nd-page"[^>]*>/i);
  if (span === null) return null;
  return removeElements(removeElements(html.slice(span[0], span[1]), "script"), "nav");
}

async function runCase(smokeCase: SmokeCase): Promise<string[]> {
  const response = await fetch(`${base}${smokeCase.path}`, { redirect: "manual" });
  const body = await response.text();
  const problems: string[] = [];
  if (response.status !== smokeCase.status) problems.push(`status ${response.status}, expected ${smokeCase.status}`);
  if (smokeCase.location !== undefined) {
    const location = response.headers.get("location");
    const locationPath = location === null ? null : new URL(location, base).pathname;
    if (locationPath !== smokeCase.location) problems.push(`location ${locationPath}, expected ${smokeCase.location}`);
  }
  for (const [name, expected] of Object.entries(smokeCase.headers ?? {})) {
    const actual = response.headers.get(name);
    if (actual !== expected) problems.push(`header ${name}: ${actual}, expected ${expected}`);
  }
  let haystack: string | null = body;
  if (smokeCase.scope === "article") {
    haystack = mainArticle(body);
    if (haystack === null) problems.push('no <article id="nd-page"> in the body');
  }
  if (haystack !== null) {
    for (const text of smokeCase.contains ?? []) if (!haystack.includes(text)) problems.push(`missing ${text}`);
    for (const text of smokeCase.absent ?? []) if (haystack.includes(text)) problems.push(`holds ${text}`);
  }
  return problems;
}

async function waitForServer(exited: () => boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited()) throw new Error("wrangler dev exited before it answered");
    try {
      await fetch(`${base}/`, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error(`wrangler dev did not answer on ${base}/ within 60 s`);
}

// detached puts bunx, wrangler and workerd in one process group, so the kill below reaches all of them.
const wrangler = spawn("bunx", ["wrangler", "dev", "--port", port, "--ip", "127.0.0.1"], {
  cwd: siteRoot,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
let exited = false;
const exit = new Promise<void>((resolveExit) =>
  wrangler.on("exit", () => {
    exited = true;
    resolveExit();
  }),
);

async function stopWrangler(): Promise<void> {
  if (exited || wrangler.pid === undefined) return;
  const group = -wrangler.pid;
  try {
    process.kill(group, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([exit, Bun.sleep(5_000)]);
  if (!exited) {
    try {
      process.kill(group, "SIGKILL");
    } catch {}
  }
}

let failures = 0;
try {
  await waitForServer(() => exited);
  for (const smokeCase of cases) {
    const problems = await runCase(smokeCase);
    if (problems.length === 0) {
      console.log(`ok   ${smokeCase.path} ${smokeCase.status}`);
    } else {
      failures++;
      console.log(`FAIL ${smokeCase.path}: ${problems.join("; ")}`);
    }
  }
} catch (error) {
  failures++;
  console.error(`smoke: ${(error as Error).message}`);
} finally {
  await stopWrangler();
}

console.log(`smoke: ${cases.length} cases, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
