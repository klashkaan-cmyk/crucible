/**
 * Writable git worktrees + the scope guard for `crucible optimize`.
 *
 * The editor agent mutates the config inside a throwaway git worktree, never the
 * user's real tree. Unlike bisect's `withWorktree` (detached, read-only, one per
 * commit), an optimize worktree is WRITABLE and PERSISTS for the whole run: the
 * editor edits here, the loop commits accepted candidates onto its branch, and
 * the branch becomes the bisectable artifact.
 *
 * The scope guard (`gitChangedFiles` + `withinAllowlist`) is the structural
 * anti-wirehead check: after the editor runs, every changed path must fall inside
 * the PROGRAM's mutable surface, or the candidate is rejected before any trial is
 * spent. The matcher is dependency-free (no minimatch) to keep the published
 * package lean.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ConfigRepo } from "./bisect.js";
import type { MutableSurface } from "./program.js";

const exec = promisify(execFile);

export interface Worktree {
  /** The worktree's working-tree root (the git work-tree). */
  readonly root: string;
  /** The config dir under test inside the worktree (root + relConfig). */
  readonly configDir: string;
  /** The branch the worktree is checked out on. */
  readonly branch: string;
  /** Remove the worktree and its checkout; idempotent, never throws. */
  dispose(): Promise<void>;
}

/**
 * Add a writable worktree on a fresh branch at HEAD. `-B` creates or resets the
 * branch, so a re-run with the same name starts clean.
 */
export async function openWorktree(repo: ConfigRepo, branch: string): Promise<Worktree> {
  const root = await mkdtemp(path.join(tmpdir(), "crucible-opt-"));
  await exec("git", [
    "-C", repo.root, "worktree", "add", "-B", branch, "--force", root, "HEAD",
  ]);
  return {
    root,
    configDir: path.join(root, repo.relConfig),
    branch,
    dispose: async () => {
      await exec("git", ["-C", repo.root, "worktree", "remove", "--force", root]).catch(
        () => undefined,
      );
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Reset a worktree to its branch tip, discarding uncommitted edits and untracked
 * files. Run at the top of every iteration so a crashed or timed-out editor
 * cannot corrupt the next candidate's base.
 */
export async function resetWorktree(wt: Worktree): Promise<void> {
  await exec("git", ["-C", wt.root, "reset", "--hard", "HEAD"]);
  await exec("git", ["-C", wt.root, "clean", "-fd"]);
}

/**
 * Files changed in the worktree vs HEAD -- tracked modifications AND new
 * untracked files -- as repo-root-relative, forward-slash paths. A rename
 * contributes both its new and old path. This is the surface the scope guard
 * checks.
 */
export async function gitChangedFiles(wt: Worktree): Promise<string[]> {
  const { stdout } = await exec("git", [
    "-C", wt.root, "status", "--porcelain", "-z", "--untracked-files=all",
  ]);
  return parsePorcelainZ(stdout);
}

/** Parse `git status --porcelain -z` into the set of affected paths. */
function parsePorcelainZ(out: string): string[] {
  const parts = out.split("\0").filter((p) => p.length > 0);
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3)); // skip the "XY " status prefix
    // Rename/copy entries are followed by a separate source-path field.
    if (xy.includes("R") || xy.includes("C")) {
      i++;
      if (i < parts.length) files.push(parts[i]!);
    }
  }
  return files;
}

/**
 * True when every changed file is allowed by the mutable surface: it matches at
 * least one `allow` glob and no `deny` glob (deny wins). Empty input is vacuously
 * true -- the loop checks for a no-op edit separately.
 */
export function withinAllowlist(
  files: ReadonlyArray<string>,
  surface: MutableSurface,
): boolean {
  const allow = surface.allow.map(globToRegExp);
  const deny = surface.deny.map(globToRegExp);
  return files.every((f) => {
    const p = f.replace(/\\/g, "/");
    return allow.some((r) => r.test(p)) && !deny.some((r) => r.test(p));
  });
}

/**
 * Compile a path glob to an anchored RegExp. `**` spans path segments (and `**​/`
 * matches zero or more dirs); `*` and `?` stay within a segment.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?"; // '**/' -> zero or more directories
        i += 3;
      } else {
        re += ".*"; // '**' -> anything, including '/'
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(re + "$");
}
