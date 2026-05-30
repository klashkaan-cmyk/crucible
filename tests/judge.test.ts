import { describe, expect, it } from "vitest";
import { buildPrompt, parseVerdict } from "../src/judge.js";

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"score": 4, "reason": "hashes the password"}')).toEqual({
      score: 4,
      reason: "hashes the password",
    });
  });

  it("extracts JSON embedded in surrounding text", () => {
    expect(parseVerdict('Here is my verdict: {"score": 3, "reason": "ok"} done').score).toBe(3);
  });

  it("clamps scores to 1-5", () => {
    expect(parseVerdict('{"score": 9}').score).toBe(5);
    expect(parseVerdict('{"score": -2}').score).toBe(1);
  });

  it("returns 0 sentinel when there is no parseable score", () => {
    expect(parseVerdict("no json at all").score).toBe(0);
    expect(parseVerdict('{"score": "high"}').score).toBe(0);
  });
});

describe("buildPrompt", () => {
  it("includes the rubric, agent message, and files, and demands JSON", () => {
    const p = buildPrompt("password is hashed", "I added bcrypt", "----- auth.ts\nbcrypt.hash()");
    expect(p).toContain("password is hashed");
    expect(p).toContain("I added bcrypt");
    expect(p).toContain("auth.ts");
    expect(p).toMatch(/"score"/);
  });

  it("caps an oversized agent message", () => {
    const p = buildPrompt("r", "x".repeat(10_000), "");
    expect(p.length).toBeLessThan(6000);
  });
});
