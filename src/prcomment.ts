/**
 * Sticky pull-request comment. On CI, `crucible run --pr-comment` posts the
 * results table to the PR and updates the SAME comment on every subsequent run
 * (instead of spamming a new comment each time). Identification is by a hidden
 * HTML marker in the comment body.
 *
 * The HTTP glue is thin and lives in `upsertPrComment`. The parts worth testing
 * are pure: building the comment body and deciding which existing comment to
 * reuse.
 */

import { markdownSummary } from "./report.js";
import type { Regression } from "./baseline.js";
import type { ScenarioResult } from "./types.js";

/** Hidden marker that identifies a Crucible comment for in-place updates. */
export const COMMENT_MARKER = "<!-- crucible-report -->";

/** Minimal shape of a GitHub issue comment (only what we read). */
export interface GhComment {
  readonly id: number;
  readonly body?: string;
}

/** Build the full sticky comment body, marker first so it is easy to find. */
export function buildComment(
  results: ReadonlyArray<ScenarioResult>,
  regressions: ReadonlyArray<Regression> = [],
): string {
  const ok = results.every((r) => r.gatePassed) && regressions.length === 0;
  const status = results.length === 0 ? "no scenarios" : ok ? "all gates passed" : "gate failure";
  return [
    COMMENT_MARKER,
    `**Crucible** - ${status}`,
    "",
    markdownSummary(results, regressions),
    "",
    "<sub>Posted by [Crucible](https://github.com/klashkaan-cmyk/crucible). Updates in place on each run.</sub>",
  ].join("\n");
}

/** Return the id of the existing Crucible comment, or null if there is none. */
export function findExistingComment(
  comments: ReadonlyArray<GhComment>,
  marker = COMMENT_MARKER,
): number | null {
  for (const c of comments) {
    if (c.body && c.body.includes(marker)) return c.id;
  }
  return null;
}

export interface PrCommentContext {
  readonly token: string;
  /** "owner/repo" */
  readonly repo: string;
  readonly prNumber: number;
  readonly apiBase?: string;
}

/**
 * Read PR-comment context from the GitHub Actions environment. Returns null when
 * any required piece is missing (e.g. not running in Actions, or not a PR event),
 * so the caller can warn and skip rather than crash.
 */
export function prContextFromEnv(env: NodeJS.ProcessEnv = process.env): PrCommentContext | null {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const prNumber = prNumberFromEnv(env);
  if (!token || !repo || prNumber === null) return null;
  return {
    token,
    repo,
    prNumber,
    ...(env.GITHUB_API_URL ? { apiBase: env.GITHUB_API_URL } : {}),
  };
}

/** Extract the PR number from GITHUB_REF (refs/pull/<n>/merge) or GITHUB_PR_NUMBER. */
export function prNumberFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const explicit = env.GITHUB_PR_NUMBER ?? env.PR_NUMBER;
  if (explicit && /^\d+$/.test(explicit)) return parseInt(explicit, 10);
  const ref = env.GITHUB_REF ?? "";
  const m = ref.match(/^refs\/pull\/(\d+)\//);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Post or update the sticky Crucible comment on a PR. Lists existing comments,
 * reuses ours if present (PATCH), otherwise creates one (POST). `fetchImpl` is
 * injectable for testing.
 */
export async function upsertPrComment(
  ctx: PrCommentContext,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ action: "created" | "updated"; id: number }> {
  const api = ctx.apiBase ?? "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "crucible",
  };
  const listUrl = `${api}/repos/${ctx.repo}/issues/${ctx.prNumber}/comments?per_page=100`;
  const listRes = await fetchImpl(listUrl, { headers });
  if (!listRes.ok) throw new Error(`GitHub list comments failed: ${listRes.status}`);
  const comments = (await listRes.json()) as GhComment[];
  const existing = findExistingComment(comments);

  if (existing !== null) {
    const res = await fetchImpl(`${api}/repos/${ctx.repo}/issues/comments/${existing}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`GitHub update comment failed: ${res.status}`);
    return { action: "updated", id: existing };
  }

  const res = await fetchImpl(`${api}/repos/${ctx.repo}/issues/${ctx.prNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GitHub create comment failed: ${res.status}`);
  const created = (await res.json()) as GhComment;
  return { action: "created", id: created.id };
}
