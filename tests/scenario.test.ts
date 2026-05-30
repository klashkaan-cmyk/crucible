import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../src/scenario.js";

async function tmpScenario(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-test-"));
  const file = path.join(dir, "x.scenario.yaml");
  await writeFile(file, body);
  return file;
}

describe("loadScenario", () => {
  it("loads a valid scenario with defaults", async () => {
    const file = await tmpScenario(
      `name: t\nprompt: do a thing\nassert:\n  - file_exists: out.txt\n`,
    );
    const s = await loadScenario(file);
    expect(s.name).toBe("t");
    expect(s.trials).toBe(3);
    expect(s.gate.min_pass_rate).toBe(1);
  });

  it("rejects a scenario with no assertions", async () => {
    const file = await tmpScenario(`name: t\nprompt: p\nassert: []\n`);
    await expect(loadScenario(file)).rejects.toThrow(/Invalid scenario/);
  });

  it("rejects an empty assertion", async () => {
    const file = await tmpScenario(`name: t\nprompt: p\nassert:\n  - {}\n`);
    await expect(loadScenario(file)).rejects.toThrow(/specify a check/);
  });
});
