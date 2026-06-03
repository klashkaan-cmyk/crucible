import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProgram } from "../src/program.js";

async function tmpProgram(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-prog-"));
  const file = path.join(dir, "PROGRAM.md");
  await writeFile(file, body);
  return file;
}

const EXAMPLE = fileURLToPath(new URL("../crucible/example.program.md", import.meta.url));

const MINIMAL = `# P
## Objective
Improve the config.
## Mutable surface
allow:
  - .claude/agents/x.md
## Fitness
suite: crucible/train
`;

describe("loadProgram", () => {
  it("parses the shipped example, including two-stage-k fields", async () => {
    const p = await loadProgram(EXAMPLE);
    expect(p.objective).toMatch(/security-reviewer/);
    expect(p.constraints).toMatch(/refusal/);
    expect(p.mutableSurface.allow).toContain(".claude/agents/security-reviewer.md");
    expect(p.mutableSurface.deny).toContain(".claude/settings.json");
    expect(p.fitness.suite).toBe("crucible/train");
    expect(p.fitness.k_screen).toBe(3);
    expect(p.fitness.k_confirm).toBe(12);
    expect(p.fitness.significance).toBeCloseTo(0.95);
    expect(p.fitness.accept.min_objective_gain).toBeCloseTo(0.05);
    expect(p.research?.beam_width).toBe(3);
    expect(p.research?.canary).toBe("crucible/canary");
    expect(p.research?.exploration).toMatch(/exploratory beam slot/);
  });

  it("applies defaults for a minimal program", async () => {
    const p = await loadProgram(await tmpProgram(MINIMAL));
    expect(p.constraints).toBe("");
    expect(p.mutableSurface.deny).toEqual([]);
    expect(p.fitness.k_screen).toBe(3);
    expect(p.fitness.k_confirm).toBe(12);
    expect(p.fitness.objective).toBe("pass_rate");
    expect(p.fitness.tie_breaker).toBe("median_cost");
    expect(p.fitness.accept.no_regression_vs_best).toBe(true);
    expect(p.research).toBeUndefined();
  });

  it("disables holdout/safety gates when their suites are absent", async () => {
    const p = await loadProgram(await tmpProgram(MINIMAL));
    // accept defaults are true, but with no holdout/safety suite the gate is coerced off
    expect(p.fitness.accept.holdout_no_regression).toBe(false);
    expect(p.fitness.accept.safety_must_be_stable).toBe(false);
  });

  it("keeps holdout/safety gates when the suites are present", async () => {
    const p = await loadProgram(EXAMPLE);
    expect(p.fitness.accept.holdout_no_regression).toBe(true);
    expect(p.fitness.accept.safety_must_be_stable).toBe(true);
  });

  it("rejects an unknown key in a structured section (fail closed)", async () => {
    const body = MINIMAL + "bogus_key: 1\n";
    await expect(loadProgram(await tmpProgram(body))).rejects.toThrow(/Invalid PROGRAM/);
  });

  it("rejects an unknown section", async () => {
    const body = MINIMAL + "## Bogus\nwhatever\n";
    await expect(loadProgram(await tmpProgram(body))).rejects.toThrow(/unknown section/);
  });

  it("rejects k_confirm < k_screen", async () => {
    const body = `## Objective
o
## Mutable surface
allow: [a]
## Fitness
suite: s
k_screen: 10
k_confirm: 4
`;
    await expect(loadProgram(await tmpProgram(body))).rejects.toThrow(/k_confirm must be >= k_screen/);
  });

  it("requires the Fitness section", async () => {
    const body = `## Objective
o
## Mutable surface
allow: [a]
`;
    await expect(loadProgram(await tmpProgram(body))).rejects.toThrow(/missing required section "## Fitness"/);
  });

  it("requires a non-empty allowlist", async () => {
    const body = `## Objective
o
## Mutable surface
allow: []
## Fitness
suite: s
`;
    await expect(loadProgram(await tmpProgram(body))).rejects.toThrow(/Invalid PROGRAM/);
  });
});
