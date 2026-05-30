import { describe, expect, it } from "vitest";
import { isEnabled, sanitizeProps, track } from "../src/telemetry.js";
import type { TelemetryConfig } from "../src/telemetry.js";

const cfg = (enabled: boolean): TelemetryConfig => ({
  enabled,
  anonymousId: "00000000-0000-0000-0000-000000000000",
  noticeShown: true,
});

describe("isEnabled", () => {
  it("respects the stored flag", () => {
    expect(isEnabled(cfg(true), {})).toBe(true);
    expect(isEnabled(cfg(false), {})).toBe(false);
  });

  it("honors DO_NOT_TRACK", () => {
    expect(isEnabled(cfg(true), { DO_NOT_TRACK: "1" })).toBe(false);
    expect(isEnabled(cfg(true), { DO_NOT_TRACK: "0" })).toBe(true);
  });

  it("honors CRUCIBLE_TELEMETRY off-values", () => {
    for (const v of ["0", "false", "off", "no"]) {
      expect(isEnabled(cfg(true), { CRUCIBLE_TELEMETRY: v })).toBe(false);
    }
    expect(isEnabled(cfg(true), { CRUCIBLE_TELEMETRY: "1" })).toBe(true);
  });
});

describe("sanitizeProps", () => {
  it("keeps coarse primitives", () => {
    expect(sanitizeProps({ a: 3, b: true, c: "ok" })).toEqual({ a: 3, b: true, c: "ok" });
  });

  it("drops path-like and oversized strings", () => {
    const out = sanitizeProps({
      p: "/home/user/secret.ts",
      w: "C:\\Users\\x",
      big: "x".repeat(100),
      ok: "fine",
    });
    expect(out).toEqual({ ok: "fine" });
  });
});

describe("track", () => {
  it("is a no-op when disabled (no network, no throw)", async () => {
    await expect(
      track(cfg(false), { version: "0.1.0", event: "run" }, { CRUCIBLE_TELEMETRY_URL: "http://x" }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when no endpoint is configured", async () => {
    await expect(
      track(cfg(true), { version: "0.1.0", event: "run" }, {}),
    ).resolves.toBeUndefined();
  });
});
