/**
 * The research Ideator: the hypothesis-generation stage.
 *
 * `makeIdeator` returns an IdeatorFn that, for EACH beam member, asks a tool-free
 * model (on a FROZEN reference config -- meta-agent pinning, never a candidate)
 * to propose distinct, concrete changes to try, given the objective, the config,
 * that member's weak spots, and the backlog of what has already been tried. This
 * is what makes research generative rather than merely reactive.
 *
 * Prompt construction and parsing are pure / unit-tested; the model call is a
 * thin wrapper around runHeadlessText (the judge/explain path).
 *
 * See docs/research-spec.md.
 */

import { runHeadlessText } from "./runner.js";
import { summarizeConfig, type ConfigSummary } from "./generate.js";
import { failuresDigest } from "./editor.js";
import type { IdeatorFn, Hypothesis } from "./research.js";
import type { Program } from "./program.js";

export interface IdeatorOptions {
  readonly program: Program;
  /** Frozen config the Ideator reasons ON; never a candidate. */
  readonly referenceConfigDir: string;
  readonly claudeBin?: string;
  readonly model?: string;
  readonly ideasPerMember?: number;
  readonly timeoutMs?: number;
}

/** A compact rendering of a config summary for the prompt. */
export function renderSummary(summary: ConfigSummary): string {
  const parts: string[] = [];
  parts.push(
    summary.subagents.length > 0
      ? `Subagents: ${summary.subagents.map((a) => a.name).join(", ")}`
      : "Subagents: (none)",
  );
  parts.push(
    summary.skills.length > 0
      ? `Skills: ${summary.skills.map((s) => s.name).join(", ")}`
      : "Skills: (none)",
  );
  parts.push(`CLAUDE.md: ${summary.hasClaudeMd ? "present" : "absent"}`);
  return parts.join("\n");
}

export interface IdeatorPromptInput {
  readonly program: Program;
  readonly configText: string;
  readonly failures: string;
  readonly backlog: ReadonlyArray<Hypothesis>;
  readonly n: number;
}

/** Build the Ideator prompt. Pure; no I/O. */
export function buildIdeatorPrompt(input: IdeatorPromptInput): string {
  const p = input.program;
  const lines: string[] = [
    `You are a senior engineer proposing improvements to a Claude Code configuration.`,
    `Propose ${input.n} DISTINCT, concrete hypotheses -- each a single focused change to try.`,
    "",
    "OBJECTIVE:",
    p.objective.trim(),
  ];
  if (p.constraints.trim()) lines.push("", "CONSTRAINTS:", p.constraints.trim());
  if (p.research?.exploration) lines.push("", "EXPLORATION GUIDANCE:", p.research.exploration.trim());
  lines.push("", "CURRENT CONFIG:", input.configText, "", "CURRENT WEAK SPOTS:", input.failures);
  if (input.backlog.length > 0) {
    lines.push(
      "",
      "ALREADY TRIED (do NOT repeat these):",
      ...input.backlog.slice(-30).map((h) => `- [${h.status ?? "tried"}] ${h.rationale}`),
    );
  }
  lines.push(
    "",
    "Respond with one idea per line, each line starting with 'IDEA:' and nothing else.",
  );
  return lines.join("\n");
}

/** Parse 'IDEA:' lines into hypotheses tagged to a parent beam member. Pure. */
export function parseHypotheses(text: string, parentBeam: number, idPrefix: string): Hypothesis[] {
  const out: Hypothesis[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*IDEA:\s*(.+\S)\s*$/i.exec(raw);
    if (!m) continue;
    out.push({ id: `${idPrefix}-${out.length}`, parentBeam, rationale: m[1]!, status: "proposed" });
  }
  return out;
}

/** Build the live IdeatorFn: one model call per beam member, on the reference config. */
export function makeIdeator(opts: IdeatorOptions): IdeatorFn {
  const n = opts.ideasPerMember ?? 2;
  return async (beam, round, backlog) => {
    const summary = await summarizeConfig(opts.referenceConfigDir);
    const configText = renderSummary(summary);
    const all: Hypothesis[] = [];
    for (let b = 0; b < beam.length; b++) {
      const prompt = buildIdeatorPrompt({
        program: opts.program,
        configText,
        failures: failuresDigest(beam[b]!.best.trainResults),
        backlog,
        n,
      });
      const text = await runHeadlessText({
        prompt,
        configDir: opts.referenceConfigDir,
        maxTurns: 1,
        ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      });
      all.push(...parseHypotheses(text, b, `r${round}-b${b}`).slice(0, n));
    }
    return all;
  };
}
