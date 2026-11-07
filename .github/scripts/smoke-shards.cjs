// Splits the browser smoke tests across the CI shards by recorded duration.
//
// Playwright's own --shard splits by test count, which put every slow
// side-drawers test on the last shard. Each shard runs this on the same
// commit, so all of them compute the same plan. It plans test by test, so a
// describe.configure({ mode: "serial" }) group would be split across shards.
//
//   node smoke-shards.cjs plan <list.json> <durations.json> <total> <dir>
//     Writes each shard's test list to <dir>/<shard>.txt and the Playwright
//     flag that runs it to <dir>/<shard>.args. The last shard runs every test
//     the other lists do not claim, so a test the durations file has never
//     seen still runs.
//
//   node smoke-shards.cjs verify <list.json> <selected.json>...
//     Reads Playwright's own --list output for each shard's flag and checks
//     that every test runs on exactly one shard. Playwright's list parser has
//     quirks the plan can't rule out, so CI falls back to --shard when this
//     exits with 3.
//
//   node smoke-shards.cjs durations <results.json>...
//     Prints a durations file from Playwright JSON reports, such as the
//     results.json in each shard's container-smoke artifact.
const fs = require("node:fs");
const path = require("node:path");

const PROJECT = "smoke";
// Shard 1 also exports the image cache, about 15 seconds on its build step.
const CACHE_WRITER_HEAD_START = 15;

// Playwright reads a test-list line as a title-path prefix and trims each
// part. No line can match a title with "›", a line break or outer spaces,
// so those tests stay off every list. The last shard runs them unless
// another shard's line already selects them, as it can for a test in an
// anonymous describe.
const listable = (title) =>
  title !== "" && title === title.trim() && !title.includes("›") && !/[\r\n]/.test(title);

function collectTests(report) {
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      if (!spec.tests.some((test) => test.projectName === PROJECT)) continue;
      const path = [...titles, spec.title];
      tests.push({ key: [spec.file, ...path].join(" › "), listable: path.every(listable), spec });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const fileSuite of report.suites ?? []) walk(fileSuite, []);
  return tests;
}

function median(values) {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// A line for "a › b" also selects "a › b › c", so tests whose paths are
// prefixes of each other share a shard, or one of them would run twice.
function groupByPrefix(keys) {
  const parent = new Map(keys.map((key) => [key, key]));
  const root = (key) => (parent.get(key) === key ? key : root(parent.get(key)));
  for (const shorter of keys) {
    for (const longer of keys) {
      if (longer.startsWith(`${shorter} › `)) parent.set(root(longer), root(shorter));
    }
  }
  const groups = new Map();
  for (const key of keys) groups.set(root(key), [...(groups.get(root(key)) ?? []), key]);
  return [...groups.values()];
}

function planShards(keys, durations, total, unlistable = new Set()) {
  const fallback = median(Object.values(durations));
  const seconds = (key) => durations[key] ?? fallback;
  const shards = Array.from({ length: total }, (_, index) => ({
    load: index === 0 ? CACHE_WRITER_HEAD_START : 0,
    keys: [],
  }));
  const last = shards[total - 1];
  const groups = groupByPrefix(keys)
    .map((group) => ({ keys: group, seconds: group.reduce((sum, key) => sum + seconds(key), 0) }))
    .sort((a, b) => b.seconds - a.seconds || a.keys[0].localeCompare(b.keys[0]));
  for (const group of groups) {
    const pinned = group.keys.some((key) => unlistable.has(key));
    const target = pinned ? last : shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    target.keys.push(...group.keys);
    target.load += group.seconds;
  }
  return shards.map((shard) => shard.keys.sort());
}

function testListLines(keys) {
  return keys.map((key) => `[${PROJECT}] › ${key}`).join("\n") + "\n";
}

function writePlan(plan, dir) {
  const total = plan.length;
  plan.forEach((keys, index) => {
    const shard = index + 1;
    const last = shard === total;
    const listFile = path.join(dir, `${shard}.txt`);
    fs.writeFileSync(listFile, testListLines(last ? plan.slice(0, -1).flat() : keys));
    fs.writeFileSync(path.join(dir, `${shard}.args`), `${last ? "--test-list-invert" : "--test-list"}=${listFile}`);
  });
}

// Returns the tests that would not run exactly once, by Playwright test id.
function unevenTests(allReport, selectedReports) {
  const runs = new Map(collectTests(allReport).map((test) => [test.spec.id, { key: test.key, count: 0 }]));
  const uneven = [];
  for (const report of selectedReports) {
    for (const test of collectTests(report)) {
      const entry = runs.get(test.spec.id);
      if (entry) entry.count += 1;
      else uneven.push(`${test.key} is not in the full list`);
    }
  }
  for (const { key, count } of runs.values()) if (count !== 1) uneven.push(`${key} runs on ${count} shards`);
  return uneven;
}

function durationsFromReports(reports) {
  const durations = {};
  for (const report of reports) {
    for (const { key, spec } of collectTests(report)) {
      const results = spec.tests.flatMap((test) => test.results ?? []);
      if (results.length === 0) continue;
      const seconds = results.reduce((sum, result) => sum + result.duration, 0) / 1000;
      durations[key] = Math.round(seconds * 10) / 10;
    }
  }
  return Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)));
}

function main(argv) {
  const [command, ...rest] = argv;
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  if (command === "plan") {
    const [listFile, durationsFile, total, dir] = rest;
    const tests = collectTests(readJson(listFile));
    const unlistable = new Set(tests.filter((test) => !test.listable).map((test) => test.key));
    writePlan(planShards(tests.map((test) => test.key), readJson(durationsFile), Number(total), unlistable), dir);
    return;
  }
  if (command === "verify") {
    const [listFile, ...selectedFiles] = rest;
    const uneven = unevenTests(readJson(listFile), selectedFiles.map(readJson));
    if (uneven.length > 0) {
      process.stderr.write(`The shard plan does not run every test once:\n${uneven.join("\n")}\n`);
      // Not 1, so CI can tell a bad plan from a crash.
      process.exitCode = 3;
    }
    return;
  }
  if (command === "durations") {
    process.stdout.write(JSON.stringify(durationsFromReports(rest.map(readJson)), null, 2) + "\n");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { collectTests, durationsFromReports, groupByPrefix, planShards, testListLines, unevenTests, writePlan };
