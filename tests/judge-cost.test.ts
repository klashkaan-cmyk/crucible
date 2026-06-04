import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runScenarioFile } from "../src/suite.js";

/**
 * Both the agent run and the judge call spawn `claude`; a stub bin returns a
 * fixed envelope (result = a judge JSON verdict, total_cost_usd = 0.05) for each.
 * The trial cost must therefore be agent (0.05) + judge (0.05) = 0.10, proving
 * the judge-assertion cost is folded into ScenarioResult.medianCostUsd.
 */
async function stubClaude(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-stub-"));
  const envelope = JSON.stringify({
    result: JSON.stringify({ score: 5, reason: "ok" }),
    total_cost_usd: 0.05,
    is_error: false,
    num_turns: 1,
    duration_ms: 1,
    session_id: "x",
  });
  const bin = path.join(dir, "claude-stub.mjs");
  await writeFile(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`);
  await chmod(bin, 0o755);
  return bin;
}

describe("judge cost accounting", () => {
  it("folds the judge call cost into the trial and scenario cost", async () => {
    const bin = await stubClaude();
    const suiteDir = await mkdtemp(path.join(tmpdir(), "crucible-jsuite-"));
    const file = path.join(suiteDir, "j.scenario.yaml");
    await writeFile(file, "name: j\nprompt: do a thing\ntrials: 1\nassert:\n  - judge: is the output good\n");

    const result = await runScenarioFile(file, {
      configDir: await mkdtemp(path.join(tmpdir(), "crucible-jcfg-")),
      scenarioDir: suiteDir,
      claudeBin: bin,
      keepWorkdirs: false,
    });

    const trial = result.trials[0]!;
    expect(trial.assertions[0]!.costUsd).toBeCloseTo(0.05); // judge cost surfaced on the assertion
    expect(trial.costUsd).toBeCloseTo(0.1); // agent (0.05) + judge (0.05)
    expect(result.medianCostUsd).toBeCloseTo(0.1);
  });
});
