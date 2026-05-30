import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../src/scenario.js";

async function tmpScenario(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-perf-"));
  const file = path.join(dir, "x.scenario.yaml");
  await writeFile(file, body);
  return file;
}

describe("new assertion keys parse", () => {
  it("accepts response and perf assertions", async () => {
    const file = await tmpScenario(
      [
        "name: t",
        "prompt: p",
        "assert:",
        '  - response_contains: "ok"',
        '  - response_matches: "\\\\d+"',
        "  - latency_under: 30000",
        "  - turns_under: 8",
      ].join("\n") + "\n",
    );
    const s = await loadScenario(file);
    expect(s.assert).toHaveLength(4);
  });

  it("rejects turns_under that is not a positive integer", async () => {
    const file = await tmpScenario(`name: t\nprompt: p\nassert:\n  - turns_under: 0\n`);
    await expect(loadScenario(file)).rejects.toThrow(/Invalid scenario/);
  });

  it("rejects latency_under that is not positive", async () => {
    const file = await tmpScenario(`name: t\nprompt: p\nassert:\n  - latency_under: -5\n`);
    await expect(loadScenario(file)).rejects.toThrow(/Invalid scenario/);
  });
});
