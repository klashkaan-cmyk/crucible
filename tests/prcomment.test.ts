import { describe, expect, it } from "vitest";
import {
  COMMENT_MARKER,
  buildComment,
  findExistingComment,
  prContextFromEnv,
  prNumberFromEnv,
  upsertPrComment,
} from "../src/prcomment.js";
import type { ScenarioResult } from "../src/types.js";

function result(name: string, gatePassed: boolean): ScenarioResult {
  return {
    name,
    trials: [],
    passRate: gatePassed ? 1 : 0,
    stable: gatePassed,
    medianCostUsd: 0.01,
    gatePassed,
    gateReason: gatePassed ? "ok" : "failed",
  } as ScenarioResult;
}

describe("buildComment", () => {
  it("embeds the marker and a results table", () => {
    const body = buildComment([result("login", true)]);
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("| PASS | login |");
    expect(body).toContain("all gates passed");
  });

  it("reports gate failure in the header", () => {
    expect(buildComment([result("login", false)])).toContain("gate failure");
  });
});

describe("findExistingComment", () => {
  it("returns the id of the marked comment", () => {
    const comments = [
      { id: 1, body: "unrelated" },
      { id: 2, body: `something\n${COMMENT_MARKER}\nmore` },
    ];
    expect(findExistingComment(comments)).toBe(2);
  });

  it("returns null when none match", () => {
    expect(findExistingComment([{ id: 1, body: "nope" }])).toBeNull();
  });
});

describe("prNumberFromEnv", () => {
  it("parses refs/pull/<n>/merge", () => {
    expect(prNumberFromEnv({ GITHUB_REF: "refs/pull/42/merge" })).toBe(42);
  });
  it("prefers an explicit number", () => {
    expect(prNumberFromEnv({ GITHUB_PR_NUMBER: "7", GITHUB_REF: "refs/pull/42/merge" })).toBe(7);
  });
  it("returns null off a PR", () => {
    expect(prNumberFromEnv({ GITHUB_REF: "refs/heads/main" })).toBeNull();
  });
});

describe("prContextFromEnv", () => {
  it("returns null without a token", () => {
    expect(prContextFromEnv({ GITHUB_REPOSITORY: "o/r", GITHUB_REF: "refs/pull/1/merge" })).toBeNull();
  });
  it("builds a full context", () => {
    const ctx = prContextFromEnv({
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF: "refs/pull/9/merge",
    });
    expect(ctx).toMatchObject({ token: "t", repo: "o/r", prNumber: 9 });
  });
});

describe("upsertPrComment", () => {
  const ctx = { token: "t", repo: "o/r", prNumber: 5, apiBase: "https://api.test" };

  it("creates a comment when none exists", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (!init?.method || init.method === "GET") {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ id: 123 }) } as Response;
    }) as unknown as typeof fetch;

    const r = await upsertPrComment(ctx, "body", fakeFetch);
    expect(r).toEqual({ action: "created", id: 123 });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.method).toBe("POST");
  });

  it("updates the existing comment in place", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (!init?.method || init.method === "GET") {
        return { ok: true, json: async () => [{ id: 99, body: COMMENT_MARKER }] } as Response;
      }
      return { ok: true, json: async () => ({ id: 99 }) } as Response;
    }) as unknown as typeof fetch;

    const r = await upsertPrComment(ctx, "body", fakeFetch);
    expect(r).toEqual({ action: "updated", id: 99 });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url).toContain("/issues/comments/99");
  });

  it("throws on an API error", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(upsertPrComment(ctx, "body", fakeFetch)).rejects.toThrow(/403/);
  });
});
