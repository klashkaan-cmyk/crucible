import { describe, expect, it, vi } from "vitest";
import { debounce, dedupeRoots, isRelevantChange } from "../src/watch.js";

describe("isRelevantChange", () => {
  it("accepts scenario and config files", () => {
    expect(isRelevantChange("login.scenario.yaml")).toBe(true);
    expect(isRelevantChange("CLAUDE.md")).toBe(true);
    expect(isRelevantChange("settings.json")).toBe(true);
    expect(isRelevantChange("hooks/pre-commit")).toBe(true); // extension-less hook
  });

  it("ignores VCS/build noise and uninteresting extensions", () => {
    expect(isRelevantChange(".git/index")).toBe(false);
    expect(isRelevantChange("node_modules/x/index.js")).toBe(false);
    expect(isRelevantChange("dist/cli.js")).toBe(false);
    expect(isRelevantChange("assets/logo.png")).toBe(false);
    expect(isRelevantChange("")).toBe(false);
  });
});

describe("debounce", () => {
  it("collapses a burst into a single trailing call", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d();
      d();
      d();
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() prevents a pending call", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 100);
      d();
      d.cancel();
      vi.advanceTimersByTime(200);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dedupeRoots", () => {
  it("removes duplicate absolute paths preserving order", () => {
    const out = dedupeRoots(["a", "b", "a", "./b"]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/\/a$/);
    expect(out[1]).toMatch(/\/b$/);
  });
});
