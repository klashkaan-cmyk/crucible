import { describe, expect, it } from "vitest";
import { consentSatisfied } from "../src/consent.js";
import type { TelemetryConfig } from "../src/telemetry.js";

const cfg = (termsAccepted: boolean): TelemetryConfig => ({
  enabled: true,
  anonymousId: "id",
  noticeShown: true,
  termsAccepted,
});

describe("consentSatisfied", () => {
  it("is true once terms are accepted", () => {
    expect(consentSatisfied(cfg(true), {})).toBe(true);
    expect(consentSatisfied(cfg(false), {})).toBe(false);
  });

  it("can be forced via CRUCIBLE_AGREE", () => {
    expect(consentSatisfied(cfg(false), { CRUCIBLE_AGREE: "1" })).toBe(true);
    expect(consentSatisfied(cfg(false), { CRUCIBLE_AGREE: "yes" })).toBe(true);
    expect(consentSatisfied(cfg(false), { CRUCIBLE_AGREE: "0" })).toBe(false);
  });
});
