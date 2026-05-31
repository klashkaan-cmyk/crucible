import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CASSETTE_VERSION,
  cassetteName,
  loadCassette,
  materialize,
  recordCassette,
  replayCassette,
  saveCassette,
  snapshotWorkdir,
} from "../src/cassette.js";
import type { TrialRun } from "../src/types.js";

async function tmpdirp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("cassetteName", () => {
  it("is filesystem-safe and stable", () => {
    expect(cassetteName("a/b name", 2)).toBe("a_b_name.trial2.cassette.json");
  });
});

describe("snapshotWorkdir", () => {
  it("captures files and skips runner artifacts", async () => {
    const wd = await tmpdirp("cru-snap-");
    await writeFile(path.join(wd, "out.txt"), "hello");
    await mkdir(path.join(wd, "src"), { recursive: true });
    await writeFile(path.join(wd, "src", "app.js"), "code");
    await writeFile(path.join(wd, ".crucible-settings.json"), "{}"); // must be skipped
    const files = await snapshotWorkdir(wd);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("out.txt");
    expect(paths).toContain(path.join("src", "app.js"));
    expect(paths.some((p) => p.includes(".crucible"))).toBe(false);
    const out = files.find((f) => f.path === "out.txt")!;
    expect(Buffer.from(out.base64, "base64").toString()).toBe("hello");
  });
});

describe("record -> save -> load -> replay round trip", () => {
  it("reconstructs headless, invocations, and files", async () => {
    const wd = await tmpdirp("cru-rec-");
    await writeFile(path.join(wd, "result.txt"), "the answer");
    const run: TrialRun = {
      headless: {
        result: "done",
        isError: false,
        numTurns: 3,
        durationMs: 1500,
        totalCostUsd: 0.02,
        sessionId: "s",
      },
      invocations: [{ type: "tool", name: "Edit", summary: "result.txt" }],
      workdir: wd,
    };

    const cassette = await recordCassette("scn", 0, run);
    expect(cassette.version).toBe(CASSETTE_VERSION);
    expect(cassette.files.map((f) => f.path)).toContain("result.txt");

    const store = await tmpdirp("cru-store-");
    await saveCassette(store, cassette);
    const loaded = await loadCassette(path.join(store, cassetteName("scn", 0)));

    const dest = await tmpdirp("cru-replay-");
    const replayed = await replayCassette(loaded, dest);
    expect(replayed.headless.numTurns).toBe(3);
    expect(replayed.invocations[0]!.name).toBe("Edit");
    expect(await readFile(path.join(dest, "result.txt"), "utf8")).toBe("the answer");
  });
});

describe("materialize", () => {
  it("recreates nested files", async () => {
    const dest = await tmpdirp("cru-mat-");
    await materialize(
      {
        version: CASSETTE_VERSION,
        scenario: "s",
        trialIndex: 0,
        headless: { result: "", isError: false, numTurns: 0, durationMs: 0, totalCostUsd: 0, sessionId: "" },
        invocations: [],
        files: [{ path: "a/b/c.txt", base64: Buffer.from("nested").toString("base64") }],
      },
      dest,
    );
    expect(await readFile(path.join(dest, "a", "b", "c.txt"), "utf8")).toBe("nested");
  });
});

describe("loadCassette", () => {
  it("rejects an unsupported version", async () => {
    const store = await tmpdirp("cru-ver-");
    const file = path.join(store, "x.json");
    await writeFile(file, JSON.stringify({ version: 999, files: [] }));
    await expect(loadCassette(file)).rejects.toThrow(/unsupported cassette version/);
  });
});
