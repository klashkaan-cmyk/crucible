/**
 * Record / replay cassettes -- the VCR pattern for agent runs.
 *
 * Real `claude -p` runs cost tokens and are non-deterministic, which is the core
 * objection to putting an LLM config under CI. A cassette records a real run
 * once (the headless envelope, the tool/subagent invocations, and a snapshot of
 * the files the agent produced) so later runs REPLAY it: free, instant, and
 * flake-free. You re-record only when you intentionally change the config.
 *
 * The recorded `claude` boundary is fully deterministic on replay. The only
 * assertion that still reaches the network is `judge` (it is inherently a model
 * call); everything else -- response_*, latency/turns/cost, *_invoked,
 * command_not_run/succeeds, file_*, no_secrets -- replays entirely offline
 * against the materialized workdir.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HeadlessResult, Invocation, TrialRun } from "./types.js";

export const CASSETTE_VERSION = 1 as const;

export interface RecordedFile {
  /** Path relative to the workdir root. */
  readonly path: string;
  /** File contents, base64 (handles binary + avoids JSON escaping issues). */
  readonly base64: string;
}

export interface Cassette {
  readonly version: typeof CASSETTE_VERSION;
  readonly scenario: string;
  readonly trialIndex: number;
  readonly headless: HeadlessResult;
  readonly invocations: ReadonlyArray<Invocation>;
  readonly files: ReadonlyArray<RecordedFile>;
}

/** Stable, filesystem-safe cassette filename for a scenario + trial. */
export function cassetteName(scenario: string, trialIndex: number): string {
  const safe = `${scenario}.trial${trialIndex}`.replace(/[^\w.-]/g, "_");
  return `${safe}.cassette.json`;
}

/** Directory entries the runner injects; never record or restore these. */
const SKIP = (name: string): boolean => name === ".crucible" || name.startsWith(".crucible");

const MAX_RECORD_BYTES = 1_000_000;

/** Recursively snapshot a workdir's files (skipping runner artifacts). */
export async function snapshotWorkdir(workdir: string): Promise<RecordedFile[]> {
  const out: RecordedFile[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const info = await stat(full);
        if (info.size > MAX_RECORD_BYTES) continue;
        const buf = await readFile(full);
        out.push({ path: path.relative(workdir, full), base64: buf.toString("base64") });
      } catch {
        // unreadable -> skip
      }
    }
  }
  await walk(workdir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Build a cassette from a completed real run. */
export async function recordCassette(
  scenario: string,
  trialIndex: number,
  run: TrialRun,
): Promise<Cassette> {
  return {
    version: CASSETTE_VERSION,
    scenario,
    trialIndex,
    headless: run.headless,
    invocations: [...run.invocations],
    files: await snapshotWorkdir(run.workdir),
  };
}

export async function saveCassette(dir: string, cassette: Cassette): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, cassetteName(cassette.scenario, cassette.trialIndex));
  await writeFile(file, JSON.stringify(cassette, null, 2));
}

export async function loadCassette(file: string): Promise<Cassette> {
  const data = JSON.parse(await readFile(file, "utf8")) as Cassette;
  if (data.version !== CASSETTE_VERSION) {
    throw new Error(`unsupported cassette version ${data.version} (expected ${CASSETTE_VERSION})`);
  }
  return data;
}

/** Write a cassette's recorded files into a fresh workdir. */
export async function materialize(cassette: Cassette, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const f of cassette.files) {
    const target = path.join(destDir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(f.base64, "base64"));
  }
}

/**
 * Reconstruct a TrialRun from a cassette by materializing its files into a fresh
 * workdir. The caller owns cleanup of `workdir`.
 */
export async function replayCassette(cassette: Cassette, workdir: string): Promise<TrialRun> {
  await materialize(cassette, workdir);
  return {
    headless: cassette.headless,
    invocations: [...cassette.invocations],
    workdir,
  };
}

/** Delete a leftover replay workdir, best-effort. */
export async function cleanupWorkdir(workdir: string): Promise<void> {
  await rm(workdir, { recursive: true, force: true });
}
