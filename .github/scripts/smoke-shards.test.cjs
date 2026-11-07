const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const shards = require("./smoke-shards.cjs");

const spec = (title, file, results) => ({
  title,
  file,
  tests: [{ projectName: "smoke", results }],
});

const report = {
  suites: [
    {
      title: "map.pw.ts",
      file: "map.pw.ts",
      specs: [spec("pans", "map.pw.ts", [{ duration: 4000 }])],
      suites: [
        {
          title: "landscape phone",
          file: "map.pw.ts",
          specs: [spec("keeps the panel", "map.pw.ts", [{ duration: 12340 }])],
        },
      ],
    },
    {
      title: "themes.pw.ts",
      file: "themes.pw.ts",
      specs: [
        {
          title: "only in another project",
          file: "themes.pw.ts",
          tests: [{ projectName: "themes", results: [{ duration: 1000 }] }],
        },
      ],
    },
  ],
};

test("collectTests keys smoke tests by file and title path", () => {
  assert.deepEqual(
    shards.collectTests(report).map((entry) => entry.key),
    ["map.pw.ts › pans", "map.pw.ts › landscape phone › keeps the panel"],
  );
});

test("durationsFromReports records seconds per test", () => {
  assert.deepEqual(shards.durationsFromReports([report]), {
    "map.pw.ts › landscape phone › keeps the panel": 12.3,
    "map.pw.ts › pans": 4,
  });
});

test("planShards assigns every test once and balances by duration", () => {
  const durations = { a: 100, b: 60, c: 50, d: 40, e: 10 };
  const plan = shards.planShards(Object.keys(durations), durations, 2);

  assert.deepEqual(plan.flat().sort(), ["a", "b", "c", "d", "e"]);
  const loads = plan.map((keys) => keys.reduce((sum, key) => sum + durations[key], 0));
  assert.ok(Math.abs(loads[0] - loads[1]) <= 30, `unbalanced: ${loads}`);
});

test("planShards weighs an unrecorded test at the median and starts shard 1 behind", () => {
  const plan = shards.planShards(["slow", "new", "quick"], { slow: 50, quick: 10 }, 2);

  // "new" counts as 50s and goes first, to shard 2, since shard 1 starts
  // 15s behind; "slow" then fills shard 1 and "quick" tops up shard 2.
  assert.deepEqual(plan, [["slow"], ["new", "quick"]]);
});

test("the last shard runs whatever the other lists do not claim", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smoke-shards-")), "list.txt");
  const plan = [["a › one"], ["b › two"], ["c › three"]];

  assert.equal(shards.shardArgs(plan, 2, out), `--test-list=${out}`);
  assert.equal(fs.readFileSync(out, "utf8"), "[smoke] › b › two\n");

  assert.equal(shards.shardArgs(plan, 3, out), `--test-list-invert=${out}`);
  assert.equal(fs.readFileSync(out, "utf8"), "[smoke] › a › one\n[smoke] › b › two\n");
});

// Mirrors Playwright's loadTestList. A line selects a test in the same file
// whose titles start with the line's trimmed parts.
function playwrightSelects(line, test) {
  const [, file, ...titles] = line.split("›").map((part) => part.trim());
  return file === test.file && titles.every((title, index) => test.titles[index] === title);
}

test("every test runs on exactly one shard, even with overlapping and unlistable titles", () => {
  const tests = [
    { file: "a.pw.ts", titles: ["opens"] },
    { file: "a.pw.ts", titles: ["opens", "nested"] },
    { file: "a.pw.ts", titles: ["opens", "nested", "deeper"] },
    { file: "a.pw.ts", titles: ["a › b"] },
    { file: "a.pw.ts", titles: ["a", "b"] },
    { file: "a.pw.ts", titles: [" padded"] },
    { file: "a.pw.ts", titles: ["padded"] },
    ...Array.from({ length: 12 }, (_, index) => ({ file: "b.pw.ts", titles: [`test ${index}`] })),
  ];
  const report = {
    suites: [...new Set(tests.map((entry) => entry.file))].map((file) => ({
      title: file,
      file,
      specs: [],
      suites: [],
    })),
  };
  for (const entry of tests) {
    let suite = report.suites.find((fileSuite) => fileSuite.file === entry.file);
    for (const describe of entry.titles.slice(0, -1)) {
      let child = suite.suites.find((candidate) => candidate.title === describe);
      if (!child) {
        child = { title: describe, file: entry.file, specs: [], suites: [] };
        suite.suites.push(child);
      }
      suite = child;
    }
    suite.specs.push(spec(entry.titles.at(-1), entry.file, []));
  }
  const collected = shards.collectTests(report);
  const unlistable = new Set(collected.filter((entry) => !entry.listable).map((entry) => entry.key));
  const total = 6;
  const plan = shards.planShards(collected.map((entry) => entry.key), {}, total, unlistable);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-shards-"));
  const lines = plan.map((_, index) => {
    const out = path.join(dir, `${index}.txt`);
    shards.shardArgs(plan, index + 1, out);
    return fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean);
  });

  for (const entry of tests) {
    const runs = lines.filter((shardLines, index) =>
      index < total - 1
        ? shardLines.some((line) => playwrightSelects(line, entry))
        : !shardLines.some((line) => playwrightSelects(line, entry)),
    ).length;
    assert.equal(runs, 1, `${entry.file} › ${entry.titles.join(" › ")} runs on ${runs} shards`);
  }
});
