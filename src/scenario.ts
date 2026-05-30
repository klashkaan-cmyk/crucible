/**
 * Scenario schema + loader. Scenarios are YAML files describing one behavioral
 * test: a prompt, a fixture to run it against, the assertions that must hold,
 * and a gate that decides pass/fail across trials.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const AssertionSpec = z
  .object({
    /** A file (relative to the workdir) must exist after the run. */
    file_exists: z.string().optional(),
    /** A file must exist AND match this regex. Use `path::pattern`. */
    file_matches: z.string().optional(),
    /** The agent's final text output must contain this substring. */
    response_contains: z.string().optional(),
    /** The agent's final text output must match this regex. */
    response_matches: z.string().optional(),
    /** Wall-clock duration (ms) of the run must be at or below this ceiling. */
    latency_under: z.number().positive().optional(),
    /** Number of agent turns must be at or below this ceiling. */
    turns_under: z.number().int().positive().optional(),
    /** A named subagent must have been invoked during the run. */
    subagent_invoked: z.string().optional(),
    /** A named tool must have been invoked during the run. */
    tool_invoked: z.string().optional(),
    /** A shell command matching this glob must NOT have been run. */
    command_not_run: z.string().optional(),
    /** Run this command in the workdir; assertion passes on exit code 0. */
    command_succeeds: z.string().optional(),
    /** Total run cost (USD) must be at or below this ceiling. */
    cost_under: z.number().positive().optional(),
    /** LLM-judge: score the run against this rubric (soft signal by default). */
    judge: z.string().optional(),
    /** Gate the judge: require score >= this (1-5). Opt-in; only valid with judge. */
    min_score: z.number().min(1).max(5).optional(),
    /** A file (relative to the workdir) must NOT exist after the run. */
    file_absent: z.string().optional(),
    /** No produced file may contain a hardcoded secret (keys, tokens, private keys). */
    no_secrets: z.boolean().optional(),
  })
  .refine(
    (o) =>
      [
        o.file_exists,
        o.file_matches,
        o.response_contains,
        o.response_matches,
        o.latency_under,
        o.turns_under,
        o.subagent_invoked,
        o.tool_invoked,
        o.command_not_run,
        o.command_succeeds,
        o.cost_under,
        o.judge,
        o.file_absent,
        o.no_secrets,
      ].some((v) => v !== undefined),
    { message: "each assertion must specify a check" },
  )
  .refine((o) => o.min_score === undefined || o.judge !== undefined, {
    message: "min_score is only valid together with judge",
  });

const GateSpec = z.object({
  /** Fraction of trials [0,1] that must pass for the scenario to pass. */
  min_pass_rate: z.number().min(0).max(1).default(1),
  /** Optional ceiling on median trial cost in USD. */
  max_cost_usd: z.number().positive().optional(),
});

export const ScenarioSchema = z.object({
  name: z.string().min(1),
  /** Path (relative to the scenario file) to a git-tracked fixture directory. */
  fixture: z.string().optional(),
  /** The user prompt handed to the headless agent. */
  prompt: z.string().min(1),
  /** How many times to run this scenario. */
  trials: z.number().int().positive().max(50).default(3),
  /** Cap on agent turns per trial. */
  max_turns: z.number().int().positive().max(100).default(30),
  assert: z.array(AssertionSpec).min(1),
  gate: GateSpec.default({ min_pass_rate: 1 }),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type AssertionSpecT = z.infer<typeof AssertionSpec>;

export async function loadScenario(path: string): Promise<Scenario> {
  const raw = await readFile(path, "utf8");
  const data = parseYaml(raw);
  const parsed = ScenarioSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid scenario ${path}:\n${issues}`);
  }
  return parsed.data;
}
