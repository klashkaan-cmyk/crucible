/**
 * `crucible bisect` -- binary-search the config's git history to find the commit
 * that introduced a regression. Like `git bisect run`, but the "test" is a
 * Crucible suite, and the config-under-test at each step is materialized in a
 * throwaway `git worktree` so the user's working tree is never disturbed.
 *
 * Only commits that actually touched the config path are candidates, so the
 * search space (and the number of paid runs) stays minimal.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ConfigRepo {
  readonly root: string;
  /** Config dir relative to the repo root ("" when the config IS the root). */
  readonly relConfig: string;
}

export async function resolveConfigRepo(configDir: string): Promise<ConfigRepo> {
  const { stdout } = await exec("git", ["-C", configDir, "rev-parse", "--show-toplevel"]);
  const root = stdout.trim();
  const relConfig = path.relative(root, path.resolve(configDir));
  return { root, relConfig };
}

/** Commits in `good..bad` that touched the config path, oldest -> newest. */
export async function candidateCommits(
  repo: ConfigRepo,
  good: string,
  bad: string,
): Promise<string[]> {
  const args = ["-C", repo.root, "rev-list", "--reverse", `${good}..${bad}`];
  if (repo.relConfig) args.push("--", repo.relConfig);
  const { stdout } = await exec("git", args);
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export interface CommitInfo {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}

export async function commitInfo(repo: ConfigRepo, sha: string): Promise<CommitInfo> {
  const { stdout } = await exec("git", [
    "-C", repo.root, "show", "-s", "--date=short", "--format=%h%x00%s%x00%an%x00%ad", sha,
  ]);
  const [shortSha, subject, author, date] = stdout.trim().split("\0");
  return { sha: shortSha ?? sha, subject: subject ?? "", author: author ?? "", date: date ?? "" };
}

/** Add a detached worktree at `commit`, run `fn` against it, always clean up. */
export async function withWorktree<T>(
  repo: ConfigRepo,
  commit: string,
  fn: (worktreeConfigDir: string) => Promise<T>,
): Promise<T> {
  const wt = await mkdtemp(path.join(tmpdir(), "crucible-wt-"));
  await exec("git", ["-C", repo.root, "worktree", "add", "--detach", "--force", wt, commit]);
  try {
    return await fn(path.join(wt, repo.relConfig));
  } finally {
    await exec("git", ["-C", repo.root, "worktree", "remove", "--force", wt]).catch(() => undefined);
    await rm(wt, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface BisectResult {
  /** First commit found to be bad, or null if none of the candidates were bad. */
  readonly commit: string | null;
  readonly tested: number;
}

/**
 * Generic binary search for the first "bad" commit in an oldest->newest list.
 * Assumes the predicate is monotonic (good... then bad...), which is the normal
 * regression shape. Calls `isBad` ~log2(n) times.
 */
export async function bisectFirstBad(
  commits: ReadonlyArray<string>,
  isBad: (commit: string, index: number) => Promise<boolean>,
): Promise<BisectResult> {
  let lo = 0;
  let hi = commits.length - 1;
  let commit: string | null = null;
  let tested = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    tested++;
    if (await isBad(commits[mid]!, mid)) {
      commit = commits[mid]!;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { commit, tested };
}
