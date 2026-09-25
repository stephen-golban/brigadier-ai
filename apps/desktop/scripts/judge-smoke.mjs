// Judges the CI launch smoke check from several judged launches, each with a fresh data dir:
//
//   node scripts/judge-smoke.mjs <combined-report.json> <launch-1.json> <launch-2.json> ...
//
// Cold start is judged by the median of the launches against the unchanged limit (budget ×
// tolerance): on shared runners most of it is the platform creating the window and webview
// before the page loads, and that swings by seconds between otherwise identical launches.
// Every other check is judged on the first launch exactly as the app judged it. All launches
// are printed with their startup milestones, and written to the combined report.
// Runner preparation may delay a launch, but every one of the three judged launches is kept.
// There is no retry or best-of selection: a failed launch remains part of the judgment.

import { readFileSync, writeFileSync } from "node:fs";

const [combinedPath, ...launchPaths] = process.argv.slice(2);
if (!combinedPath || launchPaths.length === 0) {
  console.error("usage: judge-smoke.mjs <combined-report.json> <launch.json>...");
  process.exit(2);
}

const launches = launchPaths.map((path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { passed: false, error: `no report at ${path}: ${error.message}` };
  }
});

const failures = [];
launches.forEach((launch, index) => {
  if (!Array.isArray(launch.checks)) {
    failures.push(`launch ${index + 1} produced no report (${launch.error ?? "unknown error"})`);
  }
});

const coldStartOf = (launch) => launch.checks?.find((check) => check.id === "coldStart");
const measured = launches.map((launch) => coldStartOf(launch)?.measured ?? null);
const limit = coldStartOf(launches[0])?.limit ?? null;
const sorted = measured.filter((value) => typeof value === "number").toSorted((a, b) => a - b);
const median = sorted.length === launches.length ? sorted[Math.floor(sorted.length / 2)] : null;

console.log(`Cold start (limit ${limit} ms, judged by the median of ${launches.length} launches):`);
launches.forEach((launch, index) => {
  const check = coldStartOf(launch);
  const value = check?.measured == null ? "n/a" : `${Math.round(check.measured)} ms`;
  console.log(`  launch ${index + 1}: ${value}; ${check?.note ?? launch.error ?? ""}`);
  for (const id of ["frameGaps", "schedulerDelay"]) {
    const timing = launch.checks?.find((candidate) => candidate.id === id);
    console.log(
      `    ${id}: ${timing ? `${timing.measured} ms (${timing.status}, limit ${timing.limit} ms)` : "n/a"}`,
    );
  }
});
console.log(`  median: ${median == null ? "n/a" : `${Math.round(median)} ms`}`);
if (median == null || limit == null || !(median < limit)) {
  failures.push(`cold start median ${median == null ? "n/a" : Math.round(median)} ms is not under ${limit} ms`);
}

const first = launches[0];
for (const check of first.checks ?? []) {
  if (check.id === "coldStart") continue;
  console.log(`${check.metric}: ${check.status} (measured ${check.measured}, limit ${check.limit}) ${check.note}`);
  if (check.status === "fail") failures.push(`${check.metric} failed on launch 1: ${check.note}`);
}

const passed = failures.length === 0;
writeFileSync(
  combinedPath,
  `${JSON.stringify(
    {
      passed,
      failures,
      coldStart: { medianMs: median, limitMs: limit, launchesMs: measured },
      launches,
    },
    null,
    2,
  )}\n`,
);
if (!passed) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log("Smoke check passed.");
