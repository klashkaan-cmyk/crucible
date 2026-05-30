import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "../src/assertions.js";
import type { HeadlessResult, TrialRun } from "../src/types.js";

function headless(over: Partial<HeadlessResult> = {}): HeadlessResult {
  return {
    result: "",
    isError: false,
    numTurns: 0,
    durationMs: 0,
    totalCostUsd: 0,
    sessionId: "s",
    ...over,
  };
}

function run(over: Partial<TrialRun> = {}): TrialRun {
  return {
    headless: headless(),
    invocations: [],
    workdir: "/nonexistent",
    ...over,
  };
}

describe("response_contains", () => {
  it("passes when the final text contains the substring", async () => {
    const [r] = await evaluateAssertions(
      [{ response_contains: "bcrypt" }],
      run({ headless: headless({ result: "I hashed it with bcrypt." }) }),
    );
    expect(r.status).toBe("pass");
  });

  it("fails when the substring is absent", async () => {
    const [r] = await evaluateAssertions(
      [{ response_contains: "argon2" }],
      run({ headless: headless({ result: "plain text stored" }) }),
    );
    expect(r.status).toBe("fail");
  });
});

describe("response_matches", () => {
  it("passes when the final text matches the regex", async () => {
    const [r] = await evaluateAssertions(
      [{ response_matches: "status:\\s*4\\d{2}" }],
      run({ headless: headless({ result: "returns status: 401 on bad auth" }) }),
    );
    expect(r.status).toBe("pass");
  });

  it("fails when the regex does not match", async () => {
    const [r] = await evaluateAssertions(
      [{ response_matches: "^OK$" }],
      run({ headless: headless({ result: "not ok" }) }),
    );
    expect(r.status).toBe("fail");
  });

  it("errors on an invalid regex instead of throwing", async () => {
    const [r] = await evaluateAssertions(
      [{ response_matches: "(" }],
      run({ headless: headless({ result: "anything" }) }),
    );
    expect(r.status).toBe("error");
  });
});

describe("latency_under", () => {
  it("passes when duration is at or below the ceiling", async () => {
    const [r] = await evaluateAssertions(
      [{ latency_under: 30000 }],
      run({ headless: headless({ durationMs: 12000 }) }),
    );
    expect(r.status).toBe("pass");
  });

  it("fails when duration exceeds the ceiling", async () => {
    const [r] = await evaluateAssertions(
      [{ latency_under: 5000 }],
      run({ headless: headless({ durationMs: 8000 }) }),
    );
    expect(r.status).toBe("fail");
  });
});

describe("turns_under", () => {
  it("passes when turns are at or below the ceiling", async () => {
    const [r] = await evaluateAssertions(
      [{ turns_under: 8 }],
      run({ headless: headless({ numTurns: 5 }) }),
    );
    expect(r.status).toBe("pass");
  });

  it("fails when turns exceed the ceiling", async () => {
    const [r] = await evaluateAssertions(
      [{ turns_under: 4 }],
      run({ headless: headless({ numTurns: 9 }) }),
    );
    expect(r.status).toBe("fail");
  });
});

describe("file_exists against a real workdir", () => {
  it("passes when the file is present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crucible-assert-"));
    await writeFile(path.join(dir, "out.txt"), "hi");
    const [r] = await evaluateAssertions([{ file_exists: "out.txt" }], run({ workdir: dir }));
    expect(r.status).toBe("pass");
  });
});
