/**
 * The self-expanding frontier: grow the eval so research never tops out.
 *
 * A fixed scenario suite is an exam -- the agent can only climb to 100% and stop.
 * When the suite saturates, expandFrontier scaffolds NEW, HARDER scenarios (the
 * deterministic generate path for new capabilities + an adversarial synthesizer
 * targeting saturated ones) and admits only those with discriminating power:
 * they must PASS on the good reference (the round-0 seed config) and FAIL on a
 * weakened reference (an empty/minimal config). A scenario that passes on both --
 * or neither -- carries no signal and is discarded. A fraction is routed to the
 * holdout so the editor never sees it.
 *
 * Prompt/parse, near-miss selection, and saturation are pure. The validator and
 * orchestrator take an injected ScoreFn so they test offline.
 *
 * See docs/research-spec.md.
 */

import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScenario } from "./scenario.js";
import { renderScenarios, summarizeConfig } from "./generate.js";
import { runHeadlessText } from "./runner.js";
import type { ScoreFn } from "./optimize.js";
import type { Program } from "./program.js";
import type { ScenarioResult } from "./types.js";

export interface CandidateScenario {
  readonly name: string;
  readonly yaml: string;
  readonly filename: string;
}

// --- pure: near-miss selection + saturation ---------------------------------

/** Mean pass_rate over the suite is at/above the saturation threshold. */
export function isSaturated(results: ReadonlyArray<ScenarioResult>, threshold = 0.95): boolean {
  if (results.length === 0) return false;
  return results.reduce((s, r) => s + r.passRate, 0) / results.length >= threshold;
}

/**
 * Scenarios the config already handles well (pass rate >= threshold) -- the ones
 * worth hardening into edge-case variants. Pure.
 */
export function nearMisses(
  results: ReadonlyArray<ScenarioResult>,
  threshold = 0.5,
): ScenarioResult[] {
  return results.filter((r) => r.passRate >= threshold);
}

// --- pure: synthesizer prompt + parse ---------------------------------------

export function buildSynthPrompt(program: Program, nearMissDigest: string, n: number): string {
  return [
    "You are hardening the eval for a Claude Code configuration.",
    `Generate ${n} NEW, HARDER behavioral scenarios that probe edge cases and`,
    "tougher inputs for the same capabilities -- scenarios a strong config passes",
    "but a weak/empty config fails.",
    "",
    "OBJECTIVE the config is optimized for:",
    program.objective.trim(),
    "",
    "Capabilities currently well-handled (make harder variants of these):",
    nearMissDigest,
    "",
    "Output each scenario as a fenced ```yaml block containing a valid Crucible",
    "scenario: name, prompt, trials, assert (at least one check), gate. Nothing else.",
  ].join("\n");
}

/** Extract fenced yaml scenario blocks. Pure. */
export function parseScenarioBlocks(text: string): CandidateScenario[] {
  const out: CandidateScenario[] = [];
  const fence = /```(?:yaml)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const yaml = m[1]!.trim();
    const nameMatch = /^name:\s*(.+\S)\s*$/m.exec(yaml);
    if (!nameMatch) continue;
    const name = nameMatch[1]!.replace(/^["']|["']$/g, "").trim();
    out.push({ name, yaml: yaml + "\n", filename: `synth-${slug(name)}.scenario.yaml` });
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

// --- synthesizer (LLM-backed) -----------------------------------------------

export type SynthesizeFn = (
  program: Program,
  nearMissResults: ReadonlyArray<ScenarioResult>,
  n: number,
) => Promise<CandidateScenario[]>;

export interface SynthesizerOptions {
  /** Frozen reference config the synthesizer reasons on (meta-pinning). */
  readonly referenceConfigDir: string;
  readonly claudeBin?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export function makeSynthesizer(opts: SynthesizerOptions): SynthesizeFn {
  return async (program, nm, n) => {
    const digest =
      nm.length > 0
        ? nm.map((r) => `- ${r.name}: ${(r.passRate * 100).toFixed(0)}% pass`).join("\n")
        : "(no saturated scenarios yet -- generate fresh hard cases for the objective)";
    const text = await runHeadlessText({
      prompt: buildSynthPrompt(program, digest, n),
      configDir: opts.referenceConfigDir,
      maxTurns: 1,
      ...(opts.claudeBin ? { claudeBin: opts.claudeBin } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return parseScenarioBlocks(text);
  };
}

// --- weakened reference -----------------------------------------------------

/** Materialize the weakened reference: an empty/minimal config (bare CLAUDE.md). */
export async function materializeWeakConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-weak-"));
  await writeFile(path.join(dir, "CLAUDE.md"), "# Minimal config\n");
  return dir;
}

// --- validator --------------------------------------------------------------

/**
 * A candidate has discriminating power iff it parses, PASSES on the good
 * reference, and FAILS on the weakened reference. Otherwise it carries no signal.
 */
export async function isDiscriminating(
  candidate: CandidateScenario,
  goodConfig: string,
  weakConfig: string,
  score: ScoreFn,
  k: number,
  threshold = 0.5,
): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-cand-"));
  const file = path.join(dir, candidate.filename);
  try {
    await writeFile(file, candidate.yaml);
    try {
      await loadScenario(file);
    } catch {
      return false; // malformed -> not admissible
    }
    const good = await score({ configDir: goodConfig, scenarioDir: dir, k, kind: "confirm", iter: 0 });
    const weak = await score({ configDir: weakConfig, scenarioDir: dir, k, kind: "confirm", iter: 0 });
    const gp = good[0]?.passRate ?? 0;
    const wp = weak[0]?.passRate ?? 0;
    return gp >= threshold && wp < threshold;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- orchestrator -----------------------------------------------------------

export interface ExpandOptions {
  /** The good reference (round-0 seed config). */
  readonly configDir: string;
  readonly program: Program;
  readonly trainDir: string;
  readonly holdoutDir?: string;
  readonly score: ScoreFn;
  readonly synthesize: SynthesizeFn;
  /** Current best scoring, used to find saturated near-misses. */
  readonly currentResults: ReadonlyArray<ScenarioResult>;
  readonly n: number;
  readonly holdoutFraction?: number;
  /** Defaults to a freshly materialized empty config. */
  readonly weakConfigDir?: string;
  readonly k?: number;
  readonly passThreshold?: number;
}

export interface ExpandResult {
  readonly admittedTrain: number;
  readonly admittedHoldout: number;
  readonly rejected: number;
  readonly admitted: ReadonlyArray<string>;
}

export async function expandFrontier(opts: ExpandOptions): Promise<ExpandResult> {
  // 1. Deterministic coverage for any new subagents/skills (free).
  const summary = await summarizeConfig(opts.configDir);
  const deterministic: CandidateScenario[] = renderScenarios(summary).map((g) => ({
    name: g.filename.replace(/\.scenario\.yaml$/, ""),
    yaml: g.yaml,
    filename: g.filename,
  }));
  // 2. Adversarial synthesis targeting saturated near-misses.
  const synthesized = await opts.synthesize(
    opts.program,
    nearMisses(opts.currentResults, opts.passThreshold ?? 0.5),
    opts.n,
  );

  const candidates = dedupeByFilename([...deterministic, ...synthesized]);
  const weak = opts.weakConfigDir ?? (await materializeWeakConfig());
  const fraction = opts.holdoutFraction ?? 0.3;
  const k = opts.k ?? opts.program.fitness.k_screen;
  const threshold = opts.passThreshold ?? 0.5;

  let admittedTrain = 0;
  let admittedHoldout = 0;
  let rejected = 0;
  let seen = 0;
  const admitted: string[] = [];

  for (const c of candidates) {
    if (await existsInAny(c.filename, [opts.trainDir, opts.holdoutDir])) continue;
    const ok = await isDiscriminating(c, opts.configDir, weak, opts.score, k, threshold);
    if (!ok) {
      rejected += 1;
      continue;
    }
    const goHoldout =
      Boolean(opts.holdoutDir) &&
      Math.floor(seen * fraction) < Math.floor((seen + 1) * fraction);
    seen += 1;
    const target = goHoldout ? opts.holdoutDir! : opts.trainDir;
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, c.filename), c.yaml);
    if (goHoldout) admittedHoldout += 1;
    else admittedTrain += 1;
    admitted.push(c.filename);
  }

  return { admittedTrain, admittedHoldout, rejected, admitted };
}

function dedupeByFilename(items: ReadonlyArray<CandidateScenario>): CandidateScenario[] {
  const seen = new Set<string>();
  const out: CandidateScenario[] = [];
  for (const c of items) {
    if (seen.has(c.filename)) continue;
    seen.add(c.filename);
    out.push(c);
  }
  return out;
}

async function existsInAny(filename: string, dirs: ReadonlyArray<string | undefined>): Promise<boolean> {
  for (const d of dirs) {
    if (!d) continue;
    const ok = await access(path.join(d, filename)).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  return false;
}
