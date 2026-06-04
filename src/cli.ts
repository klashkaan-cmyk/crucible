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

import { appendFile, cp, mkdir, writeFile, access } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { fileURLToPath } from "node:url";
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
import {
  optimize,
  runSuiteScorer,
  withRetry,
  optimizeMarkdown,
  type OptimizeOptions,
} from "./optimize.js";
import { loadProgram } from "./program.js";
import { makeEditor, bootstrapSuite } from "./editor.js";
import { countByLevel, lintConfig } from "./lint.js";
import {
  bisectFirstBad,
  candidateCommits,
  commitInfo,
  resolveConfigRepo,
  withWorktree,
} from "./bisect.js";
import { EXAMPLE_SCENARIO, EXAMPLE_WORKFLOW } from "./templates.js";
import { configPath, isEnabled, loadConfig, maybeShowNotice, setEnabled, track } from "./telemetry.js";
import { renderHtml, renderTerminal } from "./diffview.js";
import { diffSteps, loadTranscript } from "./transcript.js";
import { debounce, dedupeRoots, isRelevantChange } from "./watch.js";
import { badgeEndpoint } from "./badge.js";
import { buildComment, prContextFromEnv, upsertPrComment } from "./prcomment.js";
import { renderScenarios, summarizeConfig } from "./generate.js";
import { explain } from "./explain.js";
import { loadScenario } from "./scenario.js";
import type { ScenarioResult } from "./types.js";

const VERSION = "0.6.1";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  .option("--badge <file>", "write a shields.io endpoint JSON badge to this path")
  .option("--pr-comment", "post/update a sticky results comment on the PR (CI)", false)
  .option("--record <dir>", "record each real run as a replayable cassette in this dir")
  .option("--replay <dir>", "replay runs from cassettes in this dir (no claude calls)")
  .action(runCommand);

program
  .command("watch")
  .description("Re-run the suite whenever the config or scenarios change")
  .option("-c, --config <dir>", "config dir under test (CLAUDE_CONFIG_DIR)", ".claude")
  .option("-s, --suite <dir>", "directory of *.scenario.yaml files", "crucible")
  .option("--concurrency <n>", "run up to N trials in parallel (default 1)")
  .option("--claude-bin <path>", "path to the claude binary", "claude")
  .option("--judge-model <model>", "model for LLM-judge assertions (default: CC default)")
  .option("--debounce <ms>", "wait this long after the last change before re-running", "300")
  .action(watchCommand);

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
  .option("--redteam", "also scaffold the red-team security pack into ./redteam", false)
  .action(initCommand);

program
  .command("generate")
  .description("Auto-author a starter scenario suite from an existing .claude config")
  .option("-c, --config <dir>", "config dir to read (subagents, skills, CLAUDE.md)", ".claude")
  .option("-s, --suite <dir>", "where to write generated scenarios", "crucible")
  .option("--force", "overwrite existing scenario files", false)
  .action(generateCommand);

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
  .command("explain <transcript>")
  .description("Diagnose a saved transcript: likely cause + a concrete config fix (LLM)")
  .option("--scenario <file>", "the scenario file this transcript came from (adds intent)")
  .option("--claude-bin <path>", "path to the claude binary", "claude")
  .option("--judge-model <model>", "model for the explanation (default: CC default)")
  .action(explainCommand);

program
  .command("bisect")
  .description("Find which config commit introduced a regression (git-bisect over the suite)")
  .requiredOption("--good <ref>", "a commit/ref where the suite passed")
  .option("--bad <ref>", "a commit/ref where it now fails", "HEAD")
  .option("-c, --config <dir>", "config dir under test", ".claude")
  .option("-s, --suite <dir>", "scenario suite", "crucible")
  .option("--scenario <name>", "bisect on one scenario's gate (default: any gate fails)")
  .option("-b, --baseline <file>", "treat any regression vs this baseline as bad")
  .option("--claude-bin <path>", "path to the claude binary", "claude")
  .option("--judge-model <model>", "model for LLM-judge assertions")
  .action(bisectCommand);

program
  .command("lint")
  .description("Static checks on a .claude config (no model calls, no cost)")
  .option("-c, --config <dir>", "config dir to lint", ".claude")
  .option("--json", "output findings as JSON", false)
  .action(lintCommand);

program
  .command("optimize")
  .description("Autonomously improve a config against a PROGRAM.md (commits candidates to a branch; never merges)")
  .option("-c, --config <dir>", "config dir under test", ".claude")
  .option("-p, --program <file>", "the PROGRAM.md driving the run", "PROGRAM.md")
  .option("--budget-usd <n>", "hard ceiling on total spend", "10")
  .option("--max-iters <n>", "max candidate iterations", "50")
  .option("--plateau <n>", "stop after N consecutive rejects", "8")
  .option("--branch <name>", "branch for accepted candidates (default optimize/<date>)")
  .option("--editor-model <model>", "model the editor runs as")
  .option("--judge-model <model>", "model for LLM-judge assertions")
  .option("--reference-config <dir>", "frozen config the editor runs on (default: --config)")
  .option("--concurrency <n>", "parallel trials (default 1)")
  .option("--claude-bin <path>", "path to the claude binary", "claude")
  .option("--ledger <file>", "append a JSONL run ledger here", ".crucible/optimize.jsonl")
  .option("--remeasure-every <n>", "re-score the best every N accepted candidates")
  .option("--max-turns <n>", "editor turn cap", "40")
  .option("--resume", "resume the existing branch instead of resetting it", false)
  .option("--dry-run", "evaluate would-accepts but never commit", false)
  .option("--pr-comment", "post/update a sticky results comment on the PR (CI)", false)
  .action(optimizeCommand);

program.parseAsync(process.argv);

function suiteOptions(opts: {
  config: string;
  claudeBin: string;
  judgeModel?: string;
  saveTranscripts?: string;
  concurrency?: string;
  keepWorkdirs?: boolean;
  record?: string;
  replay?: string;
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
    ...(opts.record ? { recordDir: path.resolve(opts.record) } : {}),
    ...(opts.replay ? { replayDir: path.resolve(opts.replay) } : {}),
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
  badge?: string;
  prComment?: boolean;
  record?: string;
  replay?: string;
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

  if (opts.record && opts.replay) {
    console.error(pc.red("--record and --replay are mutually exclusive."));
    process.exit(2);
  }

  const files = await requireScenarios(opts.suite);
  const suiteOpts = { ...suiteOptions(opts), scenarioDir: path.resolve(opts.suite) };
  const mode = opts.replay ? pc.cyan(" [replay]") : opts.record ? pc.cyan(" [record]") : "";
  console.error(pc.dim(`config: ${suiteOpts.configDir}  scenarios: ${files.length}${mode}\n`));

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
  if (opts.badge) {
    await writeFile(path.resolve(opts.badge), JSON.stringify(badgeEndpoint(results)) + "\n");
    if (!opts.json) console.error(pc.dim(`badge written to ${opts.badge}`));
  }
  if (opts.prComment) {
    const ctx = prContextFromEnv();
    if (!ctx) {
      console.error(pc.yellow("--pr-comment: no PR context (need GITHUB_TOKEN, GITHUB_REPOSITORY, and a pull_request event); skipping."));
    } else {
      try {
        const res = await upsertPrComment(ctx, buildComment(results, regressions));
        if (!opts.json) console.error(pc.dim(`PR comment ${res.action} (#${res.id})`));
      } catch (err) {
        console.error(pc.yellow(`--pr-comment failed: ${(err as Error).message}`));
      }
    }
  }

  await track(telemetry, {
    version: VERSION,
    event: "run",
    props: { scenarios: results.length, gates_failed: gatesFailed, regressions: regressions.length },
  });

  const failed = gatesFailed > 0 || (opts.failOnRegression && regressions.length > 0);
  process.exit(failed ? 1 : 0);
}

async function optimizeCommand(opts: {
  config: string;
  program: string;
  budgetUsd: string;
  maxIters: string;
  plateau: string;
  branch?: string;
  editorModel?: string;
  judgeModel?: string;
  referenceConfig?: string;
  concurrency?: string;
  claudeBin: string;
  ledger: string;
  remeasureEvery?: string;
  maxTurns: string;
  resume: boolean;
  dryRun: boolean;
  prComment: boolean;
}): Promise<void> {
  let telemetry;
  try {
    telemetry = await ensureConsent();
  } catch (err) {
    if (err instanceof ConsentDeclined) {
      console.error(pc.yellow("\nTerms not accepted -- nothing was run."));
      process.exit(3);
    }
    throw err;
  }
  await maybeShowNotice(telemetry);

  const program = await loadProgram(path.resolve(opts.program));
  const configDir = path.resolve(opts.config);
  const referenceConfig = path.resolve(opts.referenceConfig ?? opts.config);

  const suiteDir = path.resolve(program.fitness.suite);
  const written = await bootstrapSuite(configDir, suiteDir);
  if (written > 0) {
    console.error(pc.dim(`bootstrapped ${written} starter scenario(s) into ${suiteDir} -- review them`));
  }

  const branch = opts.branch ?? `optimize/${new Date().toISOString().slice(0, 10)}`;
  const ac = new AbortController();
  const onSignal = (): void => {
    console.error(pc.yellow("\nsignal received -- stopping after the current step..."));
    ac.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const editor = makeEditor({
    claudeBin: opts.claudeBin,
    referenceConfigDir: referenceConfig,
    maxTurns: parseInt(opts.maxTurns, 10) || 40,
    ...(opts.editorModel ? { model: opts.editorModel } : {}),
  });
  const score = withRetry(
    runSuiteScorer({
      claudeBin: opts.claudeBin,
      ...(opts.judgeModel ? { judgeModel: opts.judgeModel } : {}),
      ...(opts.concurrency ? { concurrency: Math.max(1, parseInt(opts.concurrency, 10) || 1) } : {}),
    }),
    {
      signal: ac.signal,
      onWait: (kind, attempt, ms) =>
        console.error(pc.yellow(`${kind}: backing off ${ms}ms (attempt ${attempt + 1})`)),
    },
  );

  const ledgerPath = path.resolve(opts.ledger);
  await mkdir(path.dirname(ledgerPath), { recursive: true }).catch(() => undefined);

  const optOpts: OptimizeOptions = {
    configDir,
    program,
    editor,
    score,
    branch,
    budgetUsd: parseFloat(opts.budgetUsd) || 10,
    maxIters: parseInt(opts.maxIters, 10) || 50,
    plateauIters: parseInt(opts.plateau, 10) || 8,
    ledgerPath,
    signal: ac.signal,
    resume: opts.resume,
    dryRun: opts.dryRun,
    ...(opts.remeasureEvery ? { remeasureEvery: parseInt(opts.remeasureEvery, 10) } : {}),
  };

  console.error(
    pc.dim(`optimize: suite ${program.fitness.suite} on ${configDir} -> ${branch}${opts.dryRun ? " [dry-run]" : ""}\n`),
  );

  const summary = await optimize(optOpts);

  console.log("\n" + optimizeMarkdown(summary).split("\n").slice(1).join("\n"));

  if (opts.prComment && !opts.dryRun) {
    const ctx = prContextFromEnv();
    if (!ctx) {
      console.error(pc.yellow("--pr-comment: no PR context (need GITHUB_TOKEN, GITHUB_REPOSITORY, a PR event); skipping."));
    } else {
      try {
        const res = await upsertPrComment(ctx, optimizeMarkdown(summary));
        console.error(pc.dim(`PR comment ${res.action} (#${res.id})`));
      } catch (err) {
        console.error(pc.yellow(`--pr-comment failed: ${(err as Error).message}`));
      }
    }
  }

  await track(telemetry, {
    version: VERSION,
    event: "optimize",
    props: { accepted: summary.accepted, iters: summary.iters },
  });

  process.exit(summary.accepted > 0 ? 0 : 1);
}

async function watchCommand(opts: {
  config: string;
  suite: string;
  concurrency?: string;
  claudeBin: string;
  judgeModel?: string;
  debounce: string;
}): Promise<void> {
  const telemetry = await ensureConsent();
  await maybeShowNotice(telemetry);

  await requireScenarios(opts.suite);
  const suiteOpts = {
    ...suiteOptions({ ...opts, keepWorkdirs: false }),
    scenarioDir: path.resolve(opts.suite),
  };
  const roots = dedupeRoots([suiteOpts.configDir, suiteOpts.scenarioDir]);
  const delayMs = Math.max(0, parseInt(opts.debounce, 10) || 300);

  let running = false;
  let rerunQueued = false;

  async function runOnce(): Promise<void> {
    if (running) {
      rerunQueued = true;
      return;
    }
    running = true;
    try {
      const scenarios = await requireScenarios(opts.suite);
      console.log(pc.dim(`\n--- run (${scenarios.length} scenario(s)) ---`));
      const results = await runSuite(scenarios, suiteOpts);
      printConsole(results);
      const gatesFailed = results.filter((r) => !r.gatePassed).length;
      console.log(
        gatesFailed === 0
          ? pc.green("All gates passed")
          : pc.red(`${gatesFailed} gate(s) failed`),
      );
    } catch (err) {
      console.error(pc.red(`run failed: ${(err as Error).message}`));
    } finally {
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        void runOnce();
      }
    }
  }

  const trigger = debounce(() => void runOnce(), delayMs);

  console.log(pc.cyan("crucible watch") + pc.dim(`  config: ${suiteOpts.configDir}`));
  for (const root of roots) console.log(pc.dim(`  watching ${root}`));
  console.log(pc.dim("Press Ctrl-C to stop.\n"));

  const watchers = roots.map((root) =>
    fsWatch(root, { recursive: true }, (_event, filename) => {
      if (filename && isRelevantChange(filename.toString())) trigger();
    }),
  );

  const shutdown = (): void => {
    trigger.cancel();
    for (const w of watchers) w.close();
    console.log(pc.dim("\nStopped watching."));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runOnce();
  await new Promise<void>(() => {});
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

async function generateCommand(opts: { config: string; suite: string; force?: boolean }): Promise<void> {
  const configDir = path.resolve(opts.config);
  const summary = await summarizeConfig(configDir);
  const scenarios = renderScenarios(summary);
  if (scenarios.length === 0) {
    console.error(
      pc.yellow(`No subagents, skills, or CLAUDE.md found under ${configDir}.`),
    );
    console.error(`Nothing to generate. Try ${pc.cyan("crucible init")} for a hand-written example.`);
    process.exit(2);
  }
  const dir = path.resolve(opts.suite);
  await mkdir(dir, { recursive: true });
  let written = 0;
  let skipped = 0;
  for (const s of scenarios) {
    const file = path.join(dir, s.filename);
    let present = false;
    try {
      await access(file);
      present = true;
    } catch {
      present = false;
    }
    if (present && !opts.force) {
      console.log(pc.dim(`skip (exists): ${path.join(opts.suite, s.filename)}`));
      skipped++;
      continue;
    }
    await writeFile(file, s.yaml);
    console.log(pc.green(`+ ${path.join(opts.suite, s.filename)}`));
    written++;
  }
  console.log(
    `\n${pc.bold(`${written} scenario(s) written`)}` +
      (skipped ? pc.dim(`, ${skipped} skipped (use --force to overwrite)`) : "") +
      pc.dim(`\nReview them, then run: crucible run --config ${opts.config} --suite ${opts.suite}`),
  );
}

async function initCommand(opts: { suite: string; redteam?: boolean }): Promise<void> {
  const dir = path.resolve(opts.suite);
  await mkdir(dir, { recursive: true });
  await writeIfAbsent(path.join(dir, "example.scenario.yaml"), EXAMPLE_SCENARIO);
  const wfDir = path.resolve(".github/workflows");
  await mkdir(wfDir, { recursive: true });
  await writeIfAbsent(path.join(wfDir, "crucible.yml"), EXAMPLE_WORKFLOW);
  console.log(pc.green("Scaffolded:"));
  console.log(`  ${path.join(opts.suite, "example.scenario.yaml")}`);
  console.log(`  .github/workflows/crucible.yml`);
  if (opts.redteam) {
    const dest = path.resolve("redteam");
    try {
      await access(dest);
      console.log(pc.dim("  skip (exists): redteam/"));
    } catch {
      await cp(path.join(PKG_ROOT, "redteam"), dest, { recursive: true });
      console.log(`  redteam/ (security pack -- run: crucible run --suite redteam)`);
    }
  }
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

async function explainCommand(
  transcriptFile: string,
  opts: { scenario?: string; claudeBin: string; judgeModel?: string },
): Promise<void> {
  const telemetry = await ensureConsent();
  await maybeShowNotice(telemetry);

  const transcript = await loadTranscript(transcriptFile);
  const scenario = opts.scenario ? await loadScenario(opts.scenario) : undefined;

  console.error(pc.dim(`Analyzing ${transcript.scenario} (trial ${transcript.trial})...\n`));
  const text = await explain(
    { transcript, ...(scenario ? { scenario } : {}) },
    { claudeBin: opts.claudeBin, ...(opts.judgeModel ? { model: opts.judgeModel } : {}) },
  );
  console.log(text);
}

async function bisectCommand(opts: {
  good: string;
  bad: string;
  config: string;
  suite: string;
  scenario?: string;
  baseline?: string;
  claudeBin: string;
  judgeModel?: string;
}): Promise<void> {
  try {
    await ensureConsent();
  } catch (err) {
    if (err instanceof ConsentDeclined) process.exit(3);
    throw err;
  }

  const repo = await resolveConfigRepo(path.resolve(opts.config));
  const commits = await candidateCommits(repo, opts.good, opts.bad);
  if (commits.length === 0) {
    console.error(pc.yellow(`No commits touched ${repo.relConfig || "the repo"} in ${opts.good}..${opts.bad}.`));
    process.exit(2);
  }

  const files = await requireScenarios(opts.suite);
  const scenarioDir = path.resolve(opts.suite);
  const baseline = opts.baseline ? await loadBaseline(opts.baseline) : null;
  console.error(
    pc.dim(`bisecting ${commits.length} config commit(s) -- ~${Math.ceil(Math.log2(commits.length + 1))} run(s)\n`),
  );

  const isBad = async (commit: string): Promise<boolean> => {
    const info = await commitInfo(repo, commit);
    return withWorktree(repo, commit, async (cfgDir) => {
      const results = await runSuite(files, {
        configDir: cfgDir,
        scenarioDir,
        claudeBin: opts.claudeBin,
        keepWorkdirs: false,
        ...(opts.judgeModel ? { judgeModel: opts.judgeModel } : {}),
      });
      let bad: boolean;
      if (opts.scenario) {
        const r = results.find((x) => x.name === opts.scenario);
        bad = r ? !r.gatePassed : false;
      } else if (baseline) {
        bad = diffAgainstBaseline(results, baseline).length > 0;
      } else {
        bad = results.some((x) => !x.gatePassed);
      }
      console.error(`  ${bad ? pc.red("bad ") : pc.green("good")} ${info.sha} ${pc.dim(info.subject.slice(0, 60))}`);
      return bad;
    });
  };

  const { commit, tested } = await bisectFirstBad(commits, isBad);
  console.error("");
  if (!commit) {
    console.log(pc.green(`No bad commit found among the candidates (${tested} run(s)).`));
    process.exit(0);
  }
  const info = await commitInfo(repo, commit);
  console.log(pc.red(`First bad config commit: ${info.sha}`));
  console.log(`  ${info.subject}`);
  console.log(pc.dim(`  ${info.author}, ${info.date}  (${tested} run(s))`));
  console.log(pc.dim(`  inspect: git show ${info.sha} -- ${repo.relConfig || "."}`));
  process.exit(0);
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
