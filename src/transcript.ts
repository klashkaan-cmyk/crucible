/**
 * Transcripts + diffing. A transcript is the ordered record of what an agent
 * actually did in one trial -- the sequence of tool/subagent steps, the final
 * message, and cost/turn metrics. Saved locally (never sent anywhere), it lets
 * you answer "why did this scenario regress?" by diffing a known-good run
 * against a new one, step by step.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Invocation, TrialRun } from "./types.js";

const MAX_RESULT_CHARS = 8000;

export interface Transcript {
  readonly version: 1;
  readonly scenario: string;
  readonly trial: number;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly finalResult: string;
  readonly steps: ReadonlyArray<Invocation>;
}

export function fromRun(scenario: string, trial: number, run: TrialRun): Transcript {
  return {
    version: 1,
    scenario,
    trial,
    costUsd: run.headless.totalCostUsd,
    numTurns: run.headless.numTurns,
    finalResult: run.headless.result.slice(0, MAX_RESULT_CHARS),
    steps: [...run.invocations],
  };
}

export function transcriptFileName(scenario: string, trial: number): string {
  const slug = scenario.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  return `${slug}.trial${trial}.json`;
}

export async function saveTranscript(dir: string, t: Transcript): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, transcriptFileName(t.scenario, t.trial));
  await writeFile(file, JSON.stringify(t, null, 2) + "\n");
  return file;
}

export async function loadTranscript(file: string): Promise<Transcript> {
  const t = JSON.parse(await readFile(file, "utf8")) as Transcript;
  if (t.version !== 1 || !Array.isArray(t.steps)) {
    throw new Error(`Invalid transcript file: ${file}`);
  }
  return t;
}

export function stepKey(s: Invocation): string {
  return `${s.type}:${s.name}:${s.summary ?? ""}`;
}

export function stepLabel(s: Invocation): string {
  return `${s.type === "subagent" ? "@" : ""}${s.name}${s.summary ? `  ${s.summary}` : ""}`;
}

export type DiffMarker = "same" | "add" | "del";

export interface DiffRow {
  readonly marker: DiffMarker;
  readonly a?: Invocation;
  readonly b?: Invocation;
}

/**
 * Longest-common-subsequence alignment of two step lists. Steps present in both
 * (by key) are "same"; steps only in A are "del"; only in B are "add".
 */
export function diffSteps(
  a: ReadonlyArray<Invocation>,
  b: ReadonlyArray<Invocation>,
): DiffRow[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        stepKey(a[i]!) === stepKey(b[j]!)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (stepKey(a[i]!) === stepKey(b[j]!)) {
      rows.push({ marker: "same", a: a[i], b: b[j] });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ marker: "del", a: a[i] });
      i++;
    } else {
      rows.push({ marker: "add", b: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ marker: "del", a: a[i++] });
  while (j < m) rows.push({ marker: "add", b: b[j++] });
  return rows;
}

export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly costDelta: number;
  readonly turnDelta: number;
}

export function summarizeDiff(a: Transcript, b: Transcript, rows: ReadonlyArray<DiffRow>): DiffSummary {
  return {
    added: rows.filter((r) => r.marker === "add").length,
    removed: rows.filter((r) => r.marker === "del").length,
    unchanged: rows.filter((r) => r.marker === "same").length,
    costDelta: b.costUsd - a.costUsd,
    turnDelta: b.numTurns - a.numTurns,
  };
}
