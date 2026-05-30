/**
 * LLM-judge assertions. A judge scores how well a trial's output satisfies a
 * natural-language rubric (1-5). It is a SOFT signal: by default it is reported
 * but never fails a gate. It only affects pass/fail when the scenario author
 * explicitly sets `min_score` on that assertion -- an opt-in, never automatic.
 *
 * The judge is a neutral, tool-free, one-shot query. It sees only what we put
 * in the prompt: the rubric, the agent's final message, and a bounded snapshot
 * of the files the run produced.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runHeadlessText } from "./runner.js";
import type { TrialRun } from "./types.js";

export interface JudgeOptions {
  readonly claudeBin?: string;
  readonly model?: string;
}

export interface JudgeVerdict {
  /** 1-5 when the judge answered; 0 means the judge could not be parsed. */
  readonly score: number;
  readonly reason: string;
}

const MAX_FILE_BYTES = 4000;
const MAX_TOTAL_BYTES = 20_000;
const MAX_RESULT_CHARS = 4000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".crucible"]);

export async function runJudge(
  rubric: string,
  run: TrialRun,
  opts: JudgeOptions = {},
): Promise<JudgeVerdict> {
  const snapshot = await snapshotWorkdir(run.workdir);
  const prompt = buildPrompt(rubric, run.headless.result, snapshot);
  const text = await runHeadlessText({
    prompt,
    claudeBin: opts.claudeBin,
    model: opts.model,
    maxTurns: 1,
  });
  return parseVerdict(text);
}

export function buildPrompt(rubric: string, agentResult: string, snapshot: string): string {
  const result = agentResult.slice(0, MAX_RESULT_CHARS);
  return [
    "You are a strict, impartial evaluator. Score how well the work below",
    "satisfies the rubric, on an integer scale of 1 (fails the rubric) to 5",
    "(fully satisfies it). Judge only against the rubric; do not invent extra",
    "requirements. Respond with ONLY a JSON object and nothing else:",
    '{"score": <1-5>, "reason": "<one sentence>"}',
    "",
    `RUBRIC:\n${rubric}`,
    "",
    `AGENT FINAL MESSAGE:\n${result || "(empty)"}`,
    "",
    `FILES PRODUCED:\n${snapshot || "(none)"}`,
  ].join("\n");
}

export function parseVerdict(text: string): JudgeVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { score: 0, reason: "judge returned no JSON" };
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
    const raw = Number(obj.score);
    if (!Number.isFinite(raw)) return { score: 0, reason: "judge returned no numeric score" };
    const score = Math.min(5, Math.max(1, Math.round(raw)));
    const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "";
    return { score, reason };
  } catch {
    return { score: 0, reason: "judge JSON parse error" };
  }
}

/** Collect a bounded, text-only snapshot of files the run produced. */
async function snapshotWorkdir(dir: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= MAX_TOTAL_BYTES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(current, entry.name));
        continue;
      }
      if (entry.name.startsWith(".crucible")) continue;
      const full = path.join(current, entry.name);
      try {
        const info = await stat(full);
        if (info.size > MAX_FILE_BYTES) continue;
        const buf = await readFile(full);
        if (buf.includes(0)) continue; // skip binary (null byte)
        const content = buf.toString("utf8");
        const rel = path.relative(dir, full);
        const block = `----- ${rel}\n${content}\n`;
        if (total + block.length > MAX_TOTAL_BYTES) continue;
        parts.push(block);
        total += block.length;
      } catch {
        // unreadable / non-text -> skip
      }
    }
  };
  await walk(dir);
  return parts.join("\n");
}
