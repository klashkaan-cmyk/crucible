import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countByLevel, lintConfig, parseFrontmatter } from "../src/lint.js";

async function tmpConfig(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "crucible-lint-"));
}

describe("parseFrontmatter", () => {
  it("parses leading YAML frontmatter", () => {
    expect(parseFrontmatter("---\nname: a\ndescription: b\n---\nbody")).toEqual({ name: "a", description: "b" });
  });
  it("returns null when there is no frontmatter", () => {
    expect(parseFrontmatter("# just markdown")).toBeNull();
  });
});

describe("lintConfig", () => {
  it("passes a clean config", async () => {
    const dir = await tmpConfig();
    await mkdir(path.join(dir, "agents"), { recursive: true });
    await writeFile(path.join(dir, "agents", "rev.md"), "---\nname: reviewer\ndescription: reviews code\n---\nx");
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ hooks: {} }));
    const findings = await lintConfig(dir);
    expect(findings).toEqual([]);
  });

  it("flags invalid settings JSON", async () => {
    const dir = await tmpConfig();
    await writeFile(path.join(dir, "settings.json"), "{ not json ");
    const findings = await lintConfig(dir);
    expect(findings.some((f) => f.rule === "settings-json" && f.level === "error")).toBe(true);
  });

  it("flags duplicate subagent names and missing description", async () => {
    const dir = await tmpConfig();
    await mkdir(path.join(dir, "agents"), { recursive: true });
    await writeFile(path.join(dir, "agents", "a.md"), "---\nname: dup\ndescription: one\n---\n");
    await writeFile(path.join(dir, "agents", "b.md"), "---\nname: dup\n---\n");
    const findings = await lintConfig(dir);
    expect(findings.some((f) => f.rule === "agent-duplicate-name")).toBe(true);
    expect(findings.some((f) => f.rule === "agent-description")).toBe(true);
  });

  it("flags a skill with no description (won't auto-activate)", async () => {
    const dir = await tmpConfig();
    await mkdir(path.join(dir, "skills", "foo"), { recursive: true });
    await writeFile(path.join(dir, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");
    const findings = await lintConfig(dir);
    expect(findings.some((f) => f.rule === "skill-description" && f.level === "warn")).toBe(true);
  });

  it("flags a hardcoded secret in CLAUDE.md", async () => {
    const dir = await tmpConfig();
    await writeFile(path.join(dir, "CLAUDE.md"), "Use key sk-abcdefghijklmnopqrstuvwxyz123456 for the API");
    const findings = await lintConfig(dir);
    expect(findings.some((f) => f.rule === "secret" && f.level === "error")).toBe(true);
  });

  it("counts findings by level", () => {
    const c = countByLevel([
      { rule: "x", level: "error", message: "", file: "" },
      { rule: "y", level: "warn", message: "", file: "" },
      { rule: "z", level: "warn", message: "", file: "" },
    ]);
    expect(c).toEqual({ error: 1, warn: 2, info: 0 });
  });
});
