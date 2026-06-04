import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  failuresDigest,
  buildEditorPrompt,
  editorClaudeArgs,
  bootstrapSuite,
} from "../src/editor.js";
import type { Program } from "../src/program.js";
import type { ScenarioResult } from "../src/types.js";

function failingScenario(): ScenarioResult {
  return {
    name: "login",
    trials: [
      {
        index: 0,
        assertions: [{ kind: "file_matches", status: "fail", message: "src/app.js did not match" }],
        passed: false,
        costUsd: 0,
        durationMs: 0,
      },
    ],
    passRate: 0,
    stable: false,
    medianCostUsd: 0,
    gatePassed: false,
    gateReason: "pass rate 0%",
  };
}

function passingScenario(): ScenarioResult {
  return {
    name: "ok",
    trials: [{ index: 0, assertions: [], passed: true, costUsd: 0, durationMs: 0 }],
    passRate: 1,
    stable: true,
    medianCostUsd: 0,
    gatePassed: true,
    gateReason: "",
  };
}

const program: Program = {
  objective: "Catch more real issues without raising cost.",
  constraints: "Do not weaken refusals.",
  mutableSurface: { allow: [".claude/agents/security-reviewer.md"], deny: [".claude/settings.json"] },
  fitness: {
    suite: "train",
    objective: "pass_rate",
    tie_breaker: "median_cost",
    k_screen: 3,
    k_confirm: 12,
    significance: 0.95,
    accept: {
      no_regression_vs_best: true,
      min_objective_gain: 0.05,
      holdout_no_regression: false,
      safety_must_be_stable: false,
      cost_tolerance: 0.5,
    },
  },
};

describe("failuresDigest", () => {
  it("lists failing scenarios with their failed assertions", () => {
    const d = failuresDigest([failingScenario(), passingScenario()]);
    expect(d).toMatch(/login/);
    expect(d).toMatch(/file_matches/);
    expect(d).toMatch(/did not match/);
    expect(d).not.toMatch(/All current scenarios pass/);
  });

  it("guides toward robustness when everything passes", () => {
    expect(failuresDigest([passingScenario()])).toMatch(/All current scenarios pass/);
  });
});

describe("buildEditorPrompt", () => {
  it("includes the objective, the allowlist, the denylist, and the digest", () => {
    const prompt = buildEditorPrompt(program, "WEAK: login fails");
    expect(prompt).toMatch(/Catch more real issues/);
    expect(prompt).toMatch(/Do not weaken refusals/);
    expect(prompt).toMatch(/\.claude\/agents\/security-reviewer\.md/);
    expect(prompt).toMatch(/NEVER edit/);
    expect(prompt).toMatch(/\.claude\/settings\.json/);
    expect(prompt).toMatch(/WEAK: login fails/);
    expect(prompt).toMatch(/ONLY/);
  });
});

describe("editorClaudeArgs", () => {
  it("restricts tools to Edit/Write/Read and forbids Bash", () => {
    const args = editorClaudeArgs("PROMPT", 25);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Edit,Write,Read");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Bash");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("25");
    // Bash must never appear in the allowed set
    expect(args[args.indexOf("--allowedTools") + 1]).not.toMatch(/Bash/);
  });
});

describe("bootstrapSuite", () => {
  it("scaffolds scenarios for an empty suite and is idempotent", async () => {
    const cfg = await mkdtemp(path.join(tmpdir(), "crucible-cfg-"));
    await mkdir(path.join(cfg, "agents"), { recursive: true });
    await writeFile(path.join(cfg, "agents", "foo.md"), "---\nname: foo\ndesc: Foo reviews things.\n---\nbody\n");
    const suite = await mkdtemp(path.join(tmpdir(), "crucible-suite-"));

    const written = await bootstrapSuite(cfg, suite);
    expect(written).toBeGreaterThan(0);
    // second call sees existing scenarios and writes nothing
    expect(await bootstrapSuite(cfg, suite)).toBe(0);
  });
});
