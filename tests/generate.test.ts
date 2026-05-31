import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderScenarios, summarizeConfig, type ConfigSummary } from "../src/generate.js";
import { loadScenario } from "../src/scenario.js";

describe("renderScenarios", () => {
  const summary: ConfigSummary = {
    subagents: [{ name: "security-reviewer", description: "Reviews code for vulnerabilities. Use for auth." }],
    skills: [{ name: "deep-research", description: "Multi-source research with citations." }],
    hasClaudeMd: true,
  };

  it("emits one scenario per capability plus a CLAUDE.md smoke", () => {
    const out = renderScenarios(summary);
    const names = out.map((s) => s.filename);
    expect(names).toContain("subagent-security-reviewer.scenario.yaml");
    expect(names).toContain("skill-deep-research.scenario.yaml");
    expect(names).toContain("claude-md-smoke.scenario.yaml");
  });

  it("the subagent scenario asserts subagent_invoked with the real name", () => {
    const sub = renderScenarios(summary).find((s) => s.filename.startsWith("subagent-"))!;
    expect(sub.yaml).toContain("subagent_invoked: security-reviewer");
  });

  it("every generated scenario is valid per the loader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-gen-"));
    for (const s of renderScenarios(summary)) {
      const f = path.join(dir, s.filename);
      await writeFile(f, s.yaml);
      const loaded = await loadScenario(f); // throws if invalid
      expect(loaded.name).toBeTruthy();
      expect(loaded.assert.length).toBeGreaterThan(0);
    }
  });

  it("produces nothing for an empty config", () => {
    expect(renderScenarios({ subagents: [], skills: [], hasClaudeMd: false })).toEqual([]);
  });
});

describe("summarizeConfig", () => {
  it("reads subagents, skills, and CLAUDE.md from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-cfg-"));
    await mkdir(path.join(dir, "agents"), { recursive: true });
    await writeFile(
      path.join(dir, "agents", "rev.md"),
      "---\nname: reviewer\ndescription: Reviews code.\n---\nbody",
    );
    await mkdir(path.join(dir, "skills", "research"), { recursive: true });
    await writeFile(
      path.join(dir, "skills", "research", "SKILL.md"),
      "---\nname: research\ndescription: Does research.\n---\nbody",
    );
    await writeFile(path.join(dir, "CLAUDE.md"), "# rules");

    const s = await summarizeConfig(dir);
    expect(s.subagents).toEqual([{ name: "reviewer", description: "Reviews code." }]);
    expect(s.skills).toEqual([{ name: "research", description: "Does research." }]);
    expect(s.hasClaudeMd).toBe(true);
  });

  it("is empty for a missing config dir", async () => {
    const s = await summarizeConfig("/nonexistent/path/xyz");
    expect(s.subagents).toEqual([]);
    expect(s.skills).toEqual([]);
    expect(s.hasClaudeMd).toBe(false);
  });
});
