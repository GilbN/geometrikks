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
