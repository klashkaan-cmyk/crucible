/**
 * `crucible watch` -- re-run the suite whenever the config or scenarios change.
 *
 * The file-system glue (recursive fs.watch) is thin and side-effecting; the
 * parts worth testing are pure: deciding whether a changed path is relevant,
 * and debouncing a burst of change events into a single re-run. Those live
 * here as standalone functions so they can be unit-tested without touching the
 * filesystem or spawning a watcher.
 */

import path from "node:path";

/** Files that, when changed, should trigger a re-run. */
const RELEVANT_EXT = new Set([".yaml", ".yml", ".md", ".json", ".js", ".ts", ".sh", ".mjs", ".cjs"]);

/** Directory names whose contents are noise and must never trigger a re-run. */
const IGNORED_DIRS = new Set([".git", "node_modules", ".crucible", "dist"]);

/**
 * Decide whether a changed path (relative to a watched root) should trigger a
 * re-run. Ignores VCS/build noise and files with uninteresting extensions.
 */
export function isRelevantChange(relPath: string): boolean {
  if (!relPath) return false;
  const parts = relPath.split(path.sep);
  if (parts.some((p) => IGNORED_DIRS.has(p))) return false;
  const ext = path.extname(relPath).toLowerCase();
  // Extension-less files (e.g. a hook script named `pre-commit`) are relevant;
  // a file with an extension is only relevant if it's one we care about.
  if (ext === "") return true;
  return RELEVANT_EXT.has(ext);
}

/**
 * A trailing-edge debouncer: collapses a burst of calls into a single
 * invocation that fires `delayMs` after the last call. Returns a function with
 * a `.cancel()` to clear any pending timer (useful for clean shutdown/tests).
 */
export interface Debounced {
  (): void;
  cancel(): void;
}

export function debounce(fn: () => void, delayMs: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, delayMs);
  }) as Debounced;
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

/** Unique, existing directories to watch, with non-existent ones dropped. */
export function dedupeRoots(roots: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
