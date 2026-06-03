/**
 * PROGRAM.md schema + loader.
 *
 * A PROGRAM.md is the human-owned contract that drives `crucible optimize` (and
 * `crucible research`). It is BOTH the editor agent's standing instructions and
 * the machine-readable accept policy. It is frozen during a run -- the optimizer
 * reads it, never writes it.
 *
 * The file is markdown split into `## ` sections. Prose sections (Objective,
 * Constraints) are handed to the editor verbatim. Structured sections (Mutable
 * surface, Fitness, Research) carry YAML bodies validated with zod. Unknown keys
 * and unknown sections error -- fail closed.
 *
 * See docs/optimize-spec.md and docs/research-spec.md.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const MutableSurfaceSchema = z
  .object({
    /** Glob allowlist: the only paths the editor may change. */
    allow: z.array(z.string().min(1)).min(1),
    /** Glob denylist: paths that must never be touched (hooks, settings). */
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

const AcceptSchema = z
  .object({
    /** Reject if any scenario regresses vs the current best baseline. */
    no_regression_vs_best: z.boolean().default(true),
    /** Effect-size floor: objective must beat best by at least this much. */
    min_objective_gain: z.number().min(0).default(0.05),
    /** Reject a candidate that regresses the holdout suite. */
    holdout_no_regression: z.boolean().default(true),
    /** Every safety scenario must stay pass^k. */
    safety_must_be_stable: z.boolean().default(true),
    /** Relative median-cost increase tolerated before it counts as a regression. */
    cost_tolerance: z.number().min(0).default(0.5),
  })
  .strict();

const FitnessSchema = z
  .object({
    /** Scenario dir scored every iteration; the editor sees its failures. */
    suite: z.string().min(1),
    /** Scenario dir scored only on candidates that pass `suite`; editor never sees it. */
    holdout: z.string().min(1).optional(),
    /** Hard-constraint suite (e.g. redteam); must stay pass^k every iteration. */
    safety: z.string().min(1).optional(),
    /** What to maximize. Scalar for v1; Pareto lives in the research beam. */
    objective: z.enum(["pass_rate"]).default("pass_rate"),
    tie_breaker: z.enum(["median_cost", "none"]).default("median_cost"),
    /** Cheap first pass on every candidate. */
    k_screen: z.number().int().positive().default(3),
    /** Finalists only: re-run at this k before accepting (significance test). */
    k_confirm: z.number().int().positive().default(12),
    /** Confidence level for the significance test at k_confirm. */
    significance: z.number().gt(0).lt(1).default(0.95),
    accept: AcceptSchema.default({}),
  })
  .strict()
  .refine((f) => f.k_confirm >= f.k_screen, {
    message: "k_confirm must be >= k_screen",
    path: ["k_confirm"],
  });

const ResearchSchema = z
  .object({
    beam_width: z.number().int().positive().default(3),
    ideas_per_round: z.number().int().positive().default(6),
    max_rounds: z.number().int().positive().default(40),
    expand_every: z.number().int().positive().default(5),
    saturation: z.number().gt(0).max(1).default(0.95),
    /** Frozen north-star suite: never grown, never shown to the editor/Ideator. */
    canary: z.string().min(1).optional(),
    diversity_floor: z.number().min(0).max(1).default(0.15),
    /** Prose exploration guidance, handed to the Ideator verbatim. */
    exploration: z.string().optional(),
  })
  .strict();

export type MutableSurface = z.infer<typeof MutableSurfaceSchema>;
export type Accept = z.infer<typeof AcceptSchema>;
export type Fitness = z.infer<typeof FitnessSchema>;
export type Research = z.infer<typeof ResearchSchema>;

export interface Program {
  /** Prose objective, handed to the editor verbatim. */
  readonly objective: string;
  /** Prose constraints, handed to the editor verbatim ("" if omitted). */
  readonly constraints: string;
  readonly mutableSurface: MutableSurface;
  readonly fitness: Fitness;
  /** Present only when a `## Research` section exists. */
  readonly research?: Research;
}

const KNOWN_SECTIONS = new Set([
  "objective",
  "mutable surface",
  "fitness",
  "constraints",
  "research",
]);

/** Split a PROGRAM.md into `## ` sections keyed by lowercased heading name. */
function splitSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current !== null) sections.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of content.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading && !line.startsWith("###")) {
      flush();
      current = (heading[1] ?? "")
        .replace(/<!--.*?-->/g, "")
        .trim()
        .toLowerCase();
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** Strip HTML comments before YAML parsing a structured section body. */
function parseSectionYaml(body: string): unknown {
  return parseYaml(body.replace(/<!--[\s\S]*?-->/g, ""));
}

function pushIssues(error: z.ZodError, section: string, issues: string[]): void {
  for (const i of error.issues) {
    issues.push(`  - ${section}.${i.path.join(".") || "(root)"}: ${i.message}`);
  }
}

export async function loadProgram(path: string): Promise<Program> {
  const raw = await readFile(path, "utf8");
  const sections = splitSections(raw);
  const issues: string[] = [];

  for (const key of sections.keys()) {
    if (!KNOWN_SECTIONS.has(key)) {
      issues.push(`  - (root): unknown section "## ${key}"`);
    }
  }

  const objective = sections.get("objective");
  if (objective === undefined || objective.length === 0) {
    issues.push(`  - (root): missing required prose section "## Objective"`);
  }

  const parseStructured = <S extends z.ZodTypeAny>(
    schema: S,
    name: string,
    body: string | undefined,
    required: boolean,
  ): z.infer<S> | undefined => {
    if (body === undefined) {
      if (required) issues.push(`  - (root): missing required section "## ${name}"`);
      return undefined;
    }
    let data: unknown;
    try {
      data = parseSectionYaml(body);
    } catch (err: unknown) {
      issues.push(`  - ${name}: not valid YAML (${err instanceof Error ? err.message : "parse error"})`);
      return undefined;
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      pushIssues(result.error, name, issues);
      return undefined;
    }
    return result.data;
  };

  const mutableSurface = parseStructured(
    MutableSurfaceSchema,
    "Mutable surface",
    sections.get("mutable surface"),
    true,
  );
  const fitnessParsed = parseStructured(FitnessSchema, "Fitness", sections.get("fitness"), true);
  const research = parseStructured(
    ResearchSchema,
    "Research",
    sections.get("research"),
    false,
  );

  if (issues.length > 0 || !mutableSurface || !fitnessParsed) {
    throw new Error(`Invalid PROGRAM ${path}:\n${issues.join("\n")}`);
  }

  // Gate checks only apply when their suite exists. A minimal PROGRAM is
  // Objective + Mutable surface + Fitness.suite; holdout/safety checks then
  // simply don't run rather than erroring.
  const fitness: Fitness = {
    ...fitnessParsed,
    accept: {
      ...fitnessParsed.accept,
      holdout_no_regression: fitnessParsed.holdout
        ? fitnessParsed.accept.holdout_no_regression
        : false,
      safety_must_be_stable: fitnessParsed.safety
        ? fitnessParsed.accept.safety_must_be_stable
        : false,
    },
  };

  return {
    objective: objective ?? "",
    constraints: sections.get("constraints") ?? "",
    mutableSurface,
    fitness,
    ...(research ? { research } : {}),
  };
}
