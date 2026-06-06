import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "../src/assertions.js";
import { ScenarioSchema } from "../src/scenario.js";
import type { HeadlessResult, TrialRun } from "../src/types.js";

function run(): TrialRun {
  const headless: HeadlessResult = {
    result: "",
    isError: false,
    numTurns: 0,
    durationMs: 0,
    totalCostUsd: 0,
    sessionId: "s",
  };
  return { headless, invocations: [], workdir: "/nonexistent" };
}

async function configWithEvilSkill(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-expasrt-"));
  await mkdir(path.join(dir, "skills", "evil"), { recursive: true });
  await writeFile(path.join(dir, "skills", "evil", "SKILL.md"), "---\nname: evil-skill\nversion: 6.6.6\n---\nx");
  return dir;
}

async function catalog(dir: string, severity: string): Promise<string> {
  const file = path.join(dir, "catalog.json");
  await writeFile(
    file,
    JSON.stringify({
      schema_version: "0.1.0",
      entries: [
        { id: "GHSA-1", name: "evil-skill", ecosystem: "agent-skill", package: "evil-skill", versions: ["6.6.6"], severity },
      ],
    }),
  );
  return file;
}

describe("ScenarioSchema: no_known_exposure", () => {
  const base = { name: "x", prompt: "do the thing" };

  it("accepts a no_known_exposure assertion", () => {
    const r = ScenarioSchema.safeParse({ ...base, assert: [{ no_known_exposure: "threat_intel/catalog.json" }] });
    expect(r.success).toBe(true);
  });

  it("accepts no_known_exposure with a min_severity modifier", () => {
    const r = ScenarioSchema.safeParse({
      ...base,
      assert: [{ no_known_exposure: "c.json", min_severity: "high" }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects min_severity without no_known_exposure", () => {
    const r = ScenarioSchema.safeParse({ ...base, assert: [{ file_exists: "a.txt", min_severity: "high" }] });
    expect(r.success).toBe(false);
  });
});

describe("no_known_exposure assertion", () => {
  it("fails when the config references a flagged component", async () => {
    const dir = await configWithEvilSkill();
    const cat = await catalog(dir, "critical");
    const [r] = await evaluateAssertions([{ no_known_exposure: cat }], run(), { configDir: dir });
    expect(r?.status).toBe("fail");
    expect(r?.message).toMatch(/evil-skill/);
  });

  it("passes when the catalog flags nothing in the config", async () => {
    const dir = await configWithEvilSkill();
    const cleanCat = path.join(dir, "clean.json");
    await writeFile(cleanCat, JSON.stringify({ schema_version: "0.1.0", entries: [] }));
    const [r] = await evaluateAssertions([{ no_known_exposure: cleanCat }], run(), { configDir: dir });
    expect(r?.status).toBe("pass");
  });

  it("respects min_severity: a medium finding does not trip a high gate", async () => {
    const dir = await configWithEvilSkill();
    const cat = await catalog(dir, "medium");
    const [r] = await evaluateAssertions(
      [{ no_known_exposure: cat, min_severity: "high" }],
      run(),
      { configDir: dir },
    );
    expect(r?.status).toBe("pass");
  });

  it("errors when the catalog cannot be loaded", async () => {
    const dir = await configWithEvilSkill();
    const [r] = await evaluateAssertions(
      [{ no_known_exposure: path.join(dir, "does-not-exist.json") }],
      run(),
      { configDir: dir },
    );
    expect(r?.status).toBe("error");
  });

  it("errors when no config dir is available to scan", async () => {
    const [r] = await evaluateAssertions([{ no_known_exposure: "c.json" }], run(), {});
    expect(r?.status).toBe("error");
  });
});
