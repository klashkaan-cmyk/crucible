import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveConfigRepo } from "../src/bisect.js";
import {
  globToRegExp,
  withinAllowlist,
  openWorktree,
  resetWorktree,
  gitChangedFiles,
} from "../src/worktree.js";

const exec = promisify(execFile);

describe("globToRegExp", () => {
  it("matches an exact path literally", () => {
    expect(globToRegExp(".claude/agents/x.md").test(".claude/agents/x.md")).toBe(true);
    expect(globToRegExp(".claude/agents/x.md").test(".claude/agents/y.md")).toBe(false);
  });

  it("'*' stays within a segment", () => {
    const re = globToRegExp(".claude/agents/*.md");
    expect(re.test(".claude/agents/x.md")).toBe(true);
    expect(re.test(".claude/agents/sub/x.md")).toBe(false);
  });

  it("'**' spans segments", () => {
    const re = globToRegExp(".claude/skills/security-review/**");
    expect(re.test(".claude/skills/security-review/SKILL.md")).toBe(true);
    expect(re.test(".claude/skills/security-review/sub/x.md")).toBe(true);
    expect(re.test(".claude/skills/other/SKILL.md")).toBe(false);
  });
});

describe("withinAllowlist", () => {
  const allow = [".claude/agents/security-reviewer.md", ".claude/skills/security-review/**"];

  it("allows files inside the surface", () => {
    expect(withinAllowlist([".claude/agents/security-reviewer.md"], { allow, deny: [] })).toBe(true);
    expect(withinAllowlist([".claude/skills/security-review/SKILL.md"], { allow, deny: [] })).toBe(true);
  });

  it("rejects a file outside the allowlist", () => {
    expect(withinAllowlist([".claude/settings.json"], { allow, deny: [] })).toBe(false);
  });

  it("rejects the whole set if any one file is out of scope", () => {
    const files = [".claude/agents/security-reviewer.md", ".claude/settings.json"];
    expect(withinAllowlist(files, { allow, deny: [] })).toBe(false);
  });

  it("deny wins over a broad allow", () => {
    const surface = { allow: [".claude/**"], deny: [".claude/settings.json", ".claude/hooks/**"] };
    expect(withinAllowlist([".claude/agents/x.md"], surface)).toBe(true);
    expect(withinAllowlist([".claude/settings.json"], surface)).toBe(false);
    expect(withinAllowlist([".claude/hooks/run.sh"], surface)).toBe(false);
  });
});

describe("worktree git plumbing", () => {
  async function gitRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-wt-git-"));
    await exec("git", ["-C", dir, "init", "-q"]);
    await exec("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    await exec("git", ["-C", dir, "config", "user.name", "t"]);
    await mkdir(path.join(dir, ".claude"), { recursive: true });
    await writeFile(path.join(dir, ".claude", "CLAUDE.md"), "v1");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    return dir;
  }

  it("opens a writable worktree, detects changes, resets, and disposes", async () => {
    const dir = await gitRepo();
    const repo = await resolveConfigRepo(path.join(dir, ".claude"));
    const wt = await openWorktree(repo, "optimize/test");

    expect(wt.branch).toBe("optimize/test");
    expect(await readFile(path.join(wt.configDir, "CLAUDE.md"), "utf8")).toBe("v1");

    // a tracked modification + a new untracked file
    await writeFile(path.join(wt.configDir, "CLAUDE.md"), "v2");
    await writeFile(path.join(wt.configDir, "extra.md"), "new");

    const changed = await gitChangedFiles(wt);
    expect(changed).toContain(".claude/CLAUDE.md");
    expect(changed).toContain(".claude/extra.md");

    // scope guard over real changes
    expect(withinAllowlist(changed, { allow: [".claude/**"], deny: [] })).toBe(true);
    expect(withinAllowlist(changed, { allow: [".claude/CLAUDE.md"], deny: [] })).toBe(false);

    // reset clears everything back to the branch tip
    await resetWorktree(wt);
    expect(await gitChangedFiles(wt)).toEqual([]);
    expect(await readFile(path.join(wt.configDir, "CLAUDE.md"), "utf8")).toBe("v1");

    // dispose removes the worktree from disk
    await wt.dispose();
    await expect(readFile(path.join(wt.configDir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });

  it("does not disturb the source repo's working tree", async () => {
    const dir = await gitRepo();
    const repo = await resolveConfigRepo(path.join(dir, ".claude"));
    const wt = await openWorktree(repo, "optimize/test2");
    await writeFile(path.join(wt.configDir, "CLAUDE.md"), "mutated-in-worktree");
    // the original tree is untouched
    expect(await readFile(path.join(dir, ".claude", "CLAUDE.md"), "utf8")).toBe("v1");
    await wt.dispose();
  });
});
