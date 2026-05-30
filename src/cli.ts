#!/usr/bin/env node
/**
 * Crucible CLI. Commands for v0.1:
 *   crucible run        - run a scenario suite against a .claude config
 *   crucible init       - drop an example scenario + GitHub Action into a repo
 *   crucible telemetry  - view/toggle anonymous usage stats (see TELEMETRY.md)
 *   crucible agree      - record acceptance of the Terms (TERMS.md)
 *   crucible terms      - print the Terms summary
 *
 * Exit code is non-zero when any scenario gate fails, so it gates CI directly.
 */

import { readdir, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { acceptTerms, ConsentDeclined, ensureConsent, TERMS_SUMMARY } from "./consent.js";
import { printConsole, writeJunit } from "./report.js";
import { runScenarioFile } from "./suite.js";
import { EXAMPLE_SCENARIO, EXAMPLE_WORKFLOW } from "./templates.js";
import { configPath, isEnabled, loadConfig, maybeShowNotice, setEnabled, track } from "./telemetry.js";
import type { ScenarioResult } from "./types.js";

const VERSION = "0.1.1";

const program = new Command();

program
  .name("crucible")
  .description("Regression CI for Claude Code configs (skills, subagents, hooks, CLAUDE.md)")
  .version(VERSION);

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

program
  .command("telemetry [state]")
  .description("Anonymous usage stats: 'on', 'off', or 'status' (default)")
  .action(telemetryCommand);

program
  .command("agree")
  .description("Record acceptance of the Terms & Conditions (TERMS.md)")
  .action(async () => {
    await acceptTerms();
    console.log(pc.green("Terms accepted.") + pc.dim(" Thanks -- you're set."));
  });

program
  .command("terms")
  .description("Print the Terms summary")
  .action(() => {
    console.log(TERMS_SUMMARY);
  });

program.parseAsync(process.argv);

async function runCommand(opts: {
  config: string;
  suite: string;
  junit?: string;
  claudeBin: string;
  keepWorkdirs: boolean;
}): Promise<void> {
  let telemetry;
  try {
    telemetry = await ensureConsent();
  } catch (err) {
    if (err instanceof ConsentDeclined) {
      console.error(pc.yellow("\nTerms not accepted -- nothing was run."));
      console.error(pc.dim("Uninstall with `npm rm -g crucible-ci` if you do not agree."));
      process.exit(3);
    }
    throw err;
  }
  await maybeShowNotice(telemetry);

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
  const total = results.reduce((s, r) => s + r.medianCostUsd, 0).toFixed(4);
  console.log(
    `\n${failed === 0 ? pc.green("All gates passed") : pc.red(`${failed} gate(s) failed`)}` +
      pc.dim(`  ~$${total} total median cost`),
  );

  // Coarse, non-identifying counts only. See TELEMETRY.md.
  await track(telemetry, {
    version: VERSION,
    event: "run",
    props: { scenarios: results.length, gates_failed: failed },
  });

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

async function telemetryCommand(state?: string): Promise<void> {
  const normalized = (state ?? "status").toLowerCase();
  if (normalized === "on" || normalized === "enable") {
    await setEnabled(true);
    console.log(pc.green("Telemetry enabled.") + pc.dim(" Anonymous stats only; see TELEMETRY.md."));
    return;
  }
  if (normalized === "off" || normalized === "disable") {
    await setEnabled(false);
    console.log(pc.yellow("Telemetry disabled.") + pc.dim(" No data will be sent."));
    return;
  }
  const cfg = await loadConfig();
  const on = isEnabled(cfg);
  console.log(`Telemetry: ${on ? pc.green("on") : pc.yellow("off")}`);
  console.log(pc.dim(`Config: ${configPath()}`));
  console.log(pc.dim("Toggle with `crucible telemetry on|off`, or CRUCIBLE_TELEMETRY=0 / DO_NOT_TRACK=1."));
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
