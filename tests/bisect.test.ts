import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  bisectFirstBad,
  candidateCommits,
  resolveConfigRepo,
  withWorktree,
} from "../src/bisect.js";

const exec = promisify(execFile);

describe("bisectFirstBad", () => {
  it("finds the first bad commit in a monotonic history", async () => {
    const commits = ["a", "b", "c", "d", "e"];
    const tested: string[] = [];
    const res = await bisectFirstBad(commits, async (c, i) => {
      tested.push(c);
      return i >= 2; // c, d, e are bad
    });
    expect(res.commit).toBe("c");
    expect(res.tested).toBeLessThanOrEqual(3); // log2(5) rounded up
  });

  it("returns null when nothing is bad", async () => {
    const res = await bisectFirstBad(["a", "b", "c"], async () => false);
    expect(res.commit).toBeNull();
  });

  it("handles all-bad (first commit is the culprit)", async () => {
    const res = await bisectFirstBad(["a", "b", "c"], async () => true);
    expect(res.commit).toBe("a");
  });
});

describe("git plumbing", () => {
  async function gitRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-git-"));
    await exec("git", ["-C", dir, "init", "-q"]);
    await exec("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    await exec("git", ["-C", dir, "config", "user.name", "t"]);
    await mkdir(path.join(dir, ".claude"), { recursive: true });
    return dir;
  }
  async function commit(dir: string, content: string, msg: string): Promise<void> {
    await writeFile(path.join(dir, ".claude", "CLAUDE.md"), content);
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-q", "-m", msg]);
  }

  it("lists config-touching commits and materializes them in a worktree", async () => {
    const dir = await gitRepo();
    await commit(dir, "v1", "first");
    const good = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    await commit(dir, "v2", "second");
    await commit(dir, "v3", "third");

    const repo = await resolveConfigRepo(path.join(dir, ".claude"));
    expect(repo.relConfig).toBe(".claude");

    const commits = await candidateCommits(repo, good, "HEAD");
    expect(commits).toHaveLength(2); // second + third touched .claude

    // worktree for the first candidate must contain v2's config
    const content = await withWorktree(repo, commits[0]!, async (cfgDir) =>
      readFile(path.join(cfgDir, "CLAUDE.md"), "utf8"),
    );
    expect(content).toBe("v2");
  });
});
