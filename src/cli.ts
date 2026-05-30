#!/usr/bin/env node
/**
 * Crucible CLI.
 *   crucible run        - run a scenario suite against a .claude config
 *   crucible baseline   - capture a baseline snapshot for regression diffing
 *   crucible init       - drop an example scenario + GitHub Action into a repo
 *   crucible telemetry  - view/toggle anonymous usage stats (see TELEMETRY.md)
 *   crucible agree      - record acceptance of the Terms (TERMS.md)
 *   crucible terms      - print the Terms summary
 *
 * Exit code is non-zero when any scenario gate fails (or a regression is found
 * with --fail-on-regression), so it gates CI directly.
 */

import { appendFile, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  diffAgainstBaseline,
  loadBaseline,
  toBaseline,
  writeBaseline,
  type Regression,
} from "./baseline.js";
import { acceptTerms, ConsentDeclined, ensureConsent, TERMS_SUMMARY } from "./consent.js";
import { markdownSummary, printConsole, printRegressions, resultsToJson, writeJunit } from "./report.js";
import { configFingerprint, discoverScenarios, runSuite, type SuiteOptions } from "./suite.js";
import { countByLevel, lintConfig } from "./lint.js";
import { EXAMPLE_SCENARIO, EXAMPLE_WORKFLOW } from "./templates.js";
import { configPath, isEnabled, loadConfig, maybeShowNotice, setEnabled, track } from "./telemetry.js";
import { renderHtml, renderTerminal } from "./diffview.js";
import { diffSteps, loadTranscript } from "./transcript.js";
import type { ScenarioResult } from "./types.js";

const VERSION = "0.3.0";

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
  .option("-b, --baseline <file>", "compare results against a baseline file")
  .option("--fail-on-regression", "exit non-zero if any regression is found", false)
  .option("--json", "output results as JSON to stdout", false)
  .option("--markdown <file>", "append a Markdown summary (e.g. $GITHUB_STEP_SUMMARY)")
  .option("--concurrency <n>", "run up to N trials in parallel (default 1)")
  .option("--claude-bin <path>", "path to the claude binary", "claude")
  .option("--judge-model <model>", "model for LLM-judge assertions (default: CC default)")
  .option("--save-transcripts <dir>", "save each trial transcript for later `crucible diff`")
  .option("--keep-workdirs", "do not delete trial working copies (debugging)", false)
  .action(runCommand);

program
  .command("baseline")
  .description("Run the suite and save a baseline snapshot for later regression diffs")
  .option("-c, --config <dir>", "config dir under test (CLAUDE_CONFIG_DIR)", ".claude")
  .option("-s, --suite <dir>", "directory of *.scenario.yaml files", "crucible")
  .option("-o, --out <file>", "where to write the baseline", "crucible/baseline.json")
  .option("--claude-bin <path>", "path to the claude binary", "claude")
  .option("--judge-model <model>", "model for LLM-judge assertions (default: CC default)")
  .option("--save-transcripts <dir>", "save each trial transcript alongside the baseline")
  .action(baselineCommand);

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
  .action(() => console.log(TERMS_SUMMARY));

program
  .command("diff <baseline> <current>")
  .description("Diff two saved transcripts step-by-step; --html for a viewer")
  .option("--html <file>", "write a standalone HTML diff viewer")
  .action(diffCommand);

program
  .command("lint")
  .description("Static checks on a .claude config (no model calls, no cost)")
  .option("-c, --config <dir>", "config dir to lint", ".claude")
  .option("--json", "output findings as JSON", false)
  .action(lintCommand);

program.parseAsync(process.argv);

function suiteOptions(opts: {
  config: string;
  claudeBin: string;
  judgeModel?: string;
  saveTranscripts?: string;
  concurrency?: string;
  keepWorkdirs?: boolean;
}): SuiteOptions {
  const concurrency = opts.concurrency ? Math.max(1, parseInt(opts.concurrency, 10) || 1) : 1;
  return {
    configDir: path.resolve(opts.config),
    scenarioDir: "",
    claudeBin: opts.claudeBin,
    keepWorkdirs: opts.keepWorkdirs ?? false,
    concurrency,
    ...(opts.judgeModel ? { judgeModel: opts.judgeModel } : {}),
    ...(opts.saveTranscripts ? { saveTranscriptsDir: path.resolve(opts.saveTranscripts) } : {}),
  };
}

async function requireScenarios(suiteDir: string): Promise<string[]> {
  const dir = path.resolve(suiteDir);
  const files = await discoverScenarios(dir);
  if (files.length === 0) {
    console.error(pc.yellow(`No *.scenario.yaml files found in ${dir}`));
    console.error(`Run ${pc.cyan("crucible init")} to create one.`);
    process.exit(2);
  }
  return files;
}

async function runCommand(opts: {
  config: string;
  suite: string;
  junit?: string;
  baseline?: string;
  failOnRegression: boolean;
  json?: boolean;
  markdown?: string;
  concurrency?: string;
  claudeBin: string;
  judgeModel?: string;
  saveTranscripts?: string;
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

  const files = await requireScenarios(opts.suite);
  const suiteOpts = { ...suiteOptions(opts), scenarioDir: path.resolve(opts.suite) };
  console.error(pc.dim(`config: ${suiteOpts.configDir}  scenarios: ${files.length}\n`));

  const results = await runSuite(files, suiteOpts);

  let regressions: Regression[] = [];
  if (opts.baseline) {
    regressions = diffAgainstBaseline(results, await loadBaseline(opts.baseline));
  }
  const gatesFailed = results.filter((r) => !r.gatePassed).length;

  if (opts.json) {
    process.stdout.write(JSON.stringify(resultsToJson(results, regressions), null, 2) + "\n");
  } else {
    console.log();
    printConsole(results);
    if (opts.baseline) printRegressions(regressions);
    const total = results.reduce((s, r) => s + r.medianCostUsd, 0).toFixed(4);
    console.log(
      `\n${gatesFailed === 0 ? pc.green("All gates passed") : pc.red(`${gatesFailed} gate(s) failed`)}` +
        pc.dim(`  ~$${total} total median cost`),
    );
  }

  if (opts.junit) await writeJunit(opts.junit, results);
  if (opts.markdown) {
    await appendFile(path.resolve(opts.markdown), markdownSummary(results, regressions) + "\n");
  }

  await track(telemetry, {
    version: VERSION,
    event: "run",
    props: { scenarios: results.length, gates_failed: gatesFailed, regressions: regressions.length },
  });

  const failed = gatesFailed > 0 || (opts.failOnRegression && regressions.length > 0);
  process.exit(failed ? 1 : 0);
}

async function baselineCommand(opts: {
  config: string;
  suite: string;
  out: string;
  claudeBin: string;
  judgeModel?: string;
  saveTranscripts?: string;
}): Promise<void> {
  const telemetry = await ensureConsent();
  await maybeShowNotice(telemetry);

  const files = await requireScenarios(opts.suite);
  const suiteOpts = { ...suiteOptions(opts), scenarioDir: path.resolve(opts.suite) };
  console.log(pc.dim(`Capturing baseline from ${files.length} scenario(s)...\n`));

  const results: ScenarioResult[] = await runSuite(files, suiteOpts);
  printConsole(results);

  const configRef = await configFingerprint(suiteOpts.configDir);
  const baseline = toBaseline(results, { configRef });
  await mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
  await writeBaseline(path.resolve(opts.out), baseline);
  console.log(
    pc.green(`\nBaseline saved to ${opts.out}`) +
      pc.dim(configRef ? `  (config @ ${configRef})` : ""),
  );
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

async function diffCommand(
  baselineFile: string,
  currentFile: string,
  opts: { html?: string },
): Promise<void> {
  const a = await loadTranscript(baselineFile);
  const b = await loadTranscript(currentFile);
  const rows = diffSteps(a.steps, b.steps);
  console.log(renderTerminal(a, b, rows));
  if (opts.html) {
    await writeFile(path.resolve(opts.html), renderHtml(a, b, rows));
    console.log(pc.dim(`\nHTML diff written to ${opts.html}`));
  }
}

async function lintCommand(opts: { config: string; json?: boolean }): Promise<void> {
  const dir = path.resolve(opts.config);
  const findings = await lintConfig(dir);
  const counts = countByLevel(findings);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ counts, findings }, null, 2) + "\n");
  } else if (findings.length === 0) {
    console.log(pc.green(`No issues found in ${dir}`));
  } else {
    for (const f of findings) {
      const tag =
        f.level === "error" ? pc.red("error") : f.level === "warn" ? pc.yellow("warn") : pc.dim("info");
      console.log(`${tag} ${pc.dim(f.rule)}  ${path.relative(process.cwd(), f.file)}\n    ${f.message}`);
    }
    console.log(`\n${pc.red(`${counts.error} error(s)`)}, ${pc.yellow(`${counts.warn} warning(s)`)}`);
  }
  process.exit(counts.error > 0 ? 1 : 0);
}

async function writeIfAbsent(file: string, content: string): Promise<void> {
  try {
    await access(file);
    console.log(pc.dim(`skip (exists): ${file}`));
  } catch {
    await writeFile(file, content);
  }
}
