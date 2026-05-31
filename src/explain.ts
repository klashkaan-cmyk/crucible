/**
 * `crucible explain` -- turn a red run into an actionable diagnosis. Given a
 * saved transcript (from `crucible run --save-transcripts`), a neutral tool-free
 * model reads what the agent actually did and explains the likely cause plus a
 * concrete config change to try. Optionally takes the scenario for intent +
 * the assertions that failed, which sharpens the diagnosis.
 *
 * Prompt construction is pure and unit-tested; the model call is a thin wrapper
 * around runHeadlessText (same path the judge uses).
 */

import { runHeadlessText } from "./runner.js";
import type { Transcript } from "./transcript.js";
import type { Scenario } from "./scenario.js";

export interface ExplainContext {
  readonly transcript: Transcript;
  /** The scenario this transcript came from, if available. */
  readonly scenario?: Scenario;
  /** Human-readable failed-assertion lines, e.g. "subagent_invoked:x: never fired". */
  readonly failures?: ReadonlyArray<string>;
}

/** Build the analysis prompt. Pure; no I/O. */
export function buildExplainPrompt(ctx: ExplainContext): string {
  const t = ctx.transcript;
  const steps =
    t.steps.length === 0
      ? "(the agent took no tool/subagent actions)"
      : t.steps.map((s) => `- ${s.type}: ${s.name}${s.summary ? ` (${s.summary})` : ""}`).join("\n");

  const lines: string[] = [
    "You are a senior engineer debugging a Claude Code agent configuration.",
    "Below is a recorded run that UNDERPERFORMED. Explain the most likely cause and",
    "propose ONE concrete change to the .claude config (a subagent, skill, hook, or",
    "CLAUDE.md instruction) that would fix it. Be specific and brief.",
    "",
    "Respond in this exact shape:",
    "CAUSE: <one or two sentences>",
    "FIX: <one concrete config change>",
    "",
    `SCENARIO: ${t.scenario} (trial ${t.trial})`,
  ];

  if (ctx.scenario) {
    lines.push(`INTENT (prompt given to the agent): ${ctx.scenario.prompt.trim()}`);
  }
  if (ctx.failures && ctx.failures.length > 0) {
    lines.push("", "FAILED CHECKS:", ...ctx.failures.map((f) => `- ${f}`));
  }

  lines.push(
    "",
    `RUN STATS: ${t.numTurns} turns, $${t.costUsd.toFixed(4)}`,
    "",
    "STEPS THE AGENT TOOK:",
    steps,
    "",
    "AGENT FINAL MESSAGE:",
    t.finalResult || "(empty)",
  );

  return lines.join("\n");
}

export interface ExplainOptions {
  readonly claudeBin?: string;
  readonly model?: string;
}

/** Run the explanation model query and return its text. */
export async function explain(ctx: ExplainContext, opts: ExplainOptions = {}): Promise<string> {
  const prompt = buildExplainPrompt(ctx);
  const text = await runHeadlessText({
    prompt,
    ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });
  return text.trim();
}
