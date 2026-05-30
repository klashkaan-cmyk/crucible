/**
 * Reporting. Console summary for humans + JUnit XML for CI. JUnit is the
 * lingua franca that GitHub Actions, GitLab, CircleCI, and Jenkins all render,
 * so emitting it makes Crucible a drop-in test step.
 */

import { writeFile } from "node:fs/promises";
import pc from "picocolors";
import type { Regression } from "./baseline.js";
import type { ScenarioResult } from "./types.js";

export function printConsole(results: ReadonlyArray<ScenarioResult>): void {
  for (const r of results) {
    const head = r.gatePassed ? pc.green("PASS") : pc.red("FAIL");
    const rate = `${(r.passRate * 100).toFixed(0)}%`;
    const stability = r.stable ? pc.dim("(stable)") : pc.yellow("(flaky)");
    console.log(
      `${head} ${pc.bold(r.name)}  pass-rate ${rate} ${stability}  median $${r.medianCostUsd.toFixed(4)}`,
    );
    if (!r.gatePassed) console.log(`     ${pc.red("gate:")} ${r.gateReason}`);
    for (const t of r.trials) {
      if (t.passed && r.gatePassed) continue;
      for (const a of t.assertions) {
        if (a.status === "pass") continue;
        console.log(`     ${pc.dim(`trial ${t.index}`)} ${pc.red(a.status)} ${a.kind}: ${a.message}`);
      }
      if (t.runError) console.log(`     ${pc.dim(`trial ${t.index}`)} ${pc.red("error")} ${t.runError}`);
    }
  }
}

export function junitXml(results: ReadonlyArray<ScenarioResult>): string {
  const failures = results.filter((r) => !r.gatePassed).length;
  const cases = results.map(junitCase).join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuite name="crucible" tests="${results.length}" failures="${failures}">\n` +
    `${cases}\n</testsuite>\n`
  );
}

function junitCase(r: ScenarioResult): string {
  const time = (median(r.trials.map((t) => t.durationMs)) / 1000).toFixed(3);
  const open = `  <testcase name="${escapeXml(r.name)}" time="${time}">`;
  if (r.gatePassed) return `${open}</testcase>`;
  const detail = escapeXml(r.gateReason);
  return `${open}\n    <failure message="${detail}"></failure>\n  </testcase>`;
}

export async function writeJunit(path: string, results: ReadonlyArray<ScenarioResult>): Promise<void> {
  await writeFile(path, junitXml(results));
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function printRegressions(regressions: ReadonlyArray<Regression>): void {
  if (regressions.length === 0) {
    console.log(pc.green("No regressions vs baseline."));
    return;
  }
  console.log(pc.red(`\n${regressions.length} regression(s) vs baseline:`));
  for (const r of regressions) {
    console.log(`  ${pc.red(r.kind)} ${pc.bold(r.name)}: ${r.detail}`);
  }
}
