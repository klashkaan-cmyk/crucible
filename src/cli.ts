#!/usr/bin/env node
/**
 * Crucible CLI. Two commands for v0.1:
 *   crucible run   - run a scenario suite against a .claude config
 *   crucible init  - drop an example scenario + GitHub Action into a repo
 *
 * Exit code is non-zero when any scenario gate fails, so it gates CI directly.
 */

import { readdir, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { printConsole, writeJunit } from "./report.js";
import { runScenarioFile } from "./suite.js";
import { EXAMPLE_SCENARIO, EXAMPLE_WORKFLOW } from "./templates.js";
import type { ScenarioResult } from "./types.js";

const program = new Command();

program
  .name("crucible")
  .description("Regression CI for Claude Code configs (skills, subagents, hooks, CLAUDE.md)")
  .version("0.1.0");

program
  .command("run")
  .description("Run a scenario suite against a Claude Code config")
  .option("-c, --config <dir>", "config dir under test (CLAUDE_CONFIG_DIR)", ".claude")
  .option("-s, --suite <dir>", "directory of *.scenario.yaml files", "crucible")
  .option("-o, --junit <file>", "write JUnit XML report to this path")
  .option("--claude-bin <path>", "path to the claude binary", "claude")
  .option("--keep-workdirs", "do not delete trial working copies (debugging)", false)
  .action(runCommand);

program
  .command("init")
  .description("Scaffold an example scenario + GitHub Action")
  .option("-s, --suite <dir>", "where to write scenarios", "crucible")
  .action(initCommand);

program.parseAsync(process.argv);

async function runCommand(opts: {
  config: string;
  suite: string;
  junit?: string;
  claudeBin: string;
  keepWorkdirs: boolean;
}): Promise<void> {
  const configDir = path.resolve(opts.config);
  const scenarioDir = path.resolve(opts.suite);
  const files = await discoverScenarios(scenarioDir);
  if (files.length === 0) {
    console.error(pc.yellow(`No *.scenario.yaml files found in ${scenarioDir}`));
    console.error(`Run ${pc.cyan("crucible init")} to create one.`);
    process.exit(2);
  }

  console.log(pc.dim(`config: ${configDir}  scenarios: ${files.length}\n`));
  const results: ScenarioResult[] = [];
  for (const file of files) {
    results.push(
      await runScenarioFile(file, {
        configDir,
        scenarioDir,
        claudeBin: opts.claudeBin,
        keepWorkdirs: opts.keepWorkdirs,
      }),
    );
  }

  console.log();
  printConsole(results);
  if (opts.junit) {
    await writeJunit(opts.junit, results);
    console.log(pc.dim(`\nJUnit report written to ${opts.junit}`));
  }

  const failed = results.filter((r) => !r.gatePassed).length;
  const total = (results.reduce((s, r) => s + r.medianCostUsd, 0)).toFixed(4);
  console.log(
    `\n${failed === 0 ? pc.green("All gates passed") : pc.red(`${failed} gate(s) failed`)}` +
      pc.dim(`  ~$${total} total median cost`),
  );
  process.exit(failed === 0 ? 0 : 1);
}

async function initCommand(opts: { suite: string }): Promise<void> {
  const dir = path.resolve(opts.suite);
  await mkdir(dir, { recursive: true });
  await writeIfAbsent(path.join(dir, "example.scenario.yaml"), EXAMPLE_SCENARIO);
  const wfDir = path.resolve(".github/workflows");
  await mkdir(wfDir, { recursive: true });
  await writeIfAbsent(path.join(wfDir, "crucible.yml"), EXAMPLE_WORKFLOW);
  console.log(pc.green("Scaffolded:"));
  console.log(`  ${path.join(opts.suite, "example.scenario.yaml")}`);
  console.log(`  .github/workflows/crucible.yml`);
}

async function discoverScenarios(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".scenario.yaml") || e.endsWith(".scenario.yml"))
    .map((e) => path.join(dir, e))
    .sort();
}

async function writeIfAbsent(file: string, content: string): Promise<void> {
  try {
    await access(file);
    console.log(pc.dim(`skip (exists): ${file}`));
  } catch {
    await writeFile(file, content);
  }
}
