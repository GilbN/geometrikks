// Splits the browser smoke tests across the CI shards by recorded duration.
//
// Playwright's own --shard splits by test count, which put every slow
// side-drawers test on the last shard. Each shard runs this on the same
// commit, so all of them compute the same plan.
//
//   node smoke-shards.cjs plan <list.json> <durations.json> <total> <shard> <out-file>
//     Writes this shard's test list to <out-file> and prints the Playwright
//     flag that runs it. The last shard runs every test the others' lists do
//     not claim, so a test the durations file has never seen, or a line
//     Playwright cannot match, still runs somewhere.
//
//   node smoke-shards.cjs durations <results.json>...
//     Prints a durations file from Playwright JSON reports, such as the
//     results.json in each shard's container-smoke artifact.
const fs = require("node:fs");

const PROJECT = "smoke";
// Shard 1 also exports the image cache, about 15 seconds on its build step.
const CACHE_WRITER_HEAD_START = 15;

function collectTests(report) {
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      if (!spec.tests.some((test) => test.projectName === PROJECT)) continue;
      tests.push({ key: [spec.file, ...titles, spec.title].join(" › "), spec });
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

function planShards(keys, durations, total) {
  const fallback = median(Object.values(durations));
  const weighted = keys
    .map((key) => ({ key, seconds: durations[key] ?? fallback }))
    .sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  const shards = Array.from({ length: total }, (_, index) => ({
    load: index === 0 ? CACHE_WRITER_HEAD_START : 0,
    keys: [],
  }));
  for (const test of weighted) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    lightest.keys.push(test.key);
    lightest.load += test.seconds;
  }
  return shards.map((shard) => shard.keys.sort());
}

function testListLines(keys) {
  return keys.map((key) => `[${PROJECT}] › ${key}`).join("\n") + "\n";
}

function shardArgs(plan, shard, outFile) {
  const total = plan.length;
  if (shard < total) {
    fs.writeFileSync(outFile, testListLines(plan[shard - 1]));
    return `--test-list=${outFile}`;
  }
  fs.writeFileSync(outFile, testListLines(plan.slice(0, total - 1).flat()));
  return `--test-list-invert=${outFile}`;
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
    const [listFile, durationsFile, total, shard, outFile] = rest;
    const keys = collectTests(readJson(listFile)).map((test) => test.key);
    const plan = planShards(keys, readJson(durationsFile), Number(total));
    process.stdout.write(shardArgs(plan, Number(shard), outFile));
    return;
  }
  if (command === "durations") {
    process.stdout.write(JSON.stringify(durationsFromReports(rest.map(readJson)), null, 2) + "\n");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { collectTests, durationsFromReports, planShards, shardArgs, testListLines };
