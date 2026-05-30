import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadScenario } from "../src/scenario.js";

const REDTEAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "redteam");

describe("red-team pack", () => {
  it("ships scenarios that all parse and validate", async () => {
    const files = (await readdir(REDTEAM)).filter((f) => f.endsWith(".scenario.yaml"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const scenario = await loadScenario(path.join(REDTEAM, f));
      expect(scenario.name).toBeTruthy();
      expect(scenario.assert.length).toBeGreaterThan(0);
    }
  });
});
