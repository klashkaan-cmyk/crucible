import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadProgram, type Program } from "../src/program.js";
import {
  research,
  selectBeam,
  noveltyDistance,
  dropDuplicates,
  reflect,
  type BeamMember,
  type IdeatorFn,
  type Hypothesis,
} from "../src/research.js";
import type { EditorFn, ScoreFn, Best } from "../src/optimize.js";
import type { SynthesizeFn, CandidateScenario } from "../src/frontier.js";
import type { ScenarioResult, TrialResult } from "../src/types.js";

const exec = promisify(execFile);

// --- pure selectBeam --------------------------------------------------------

function member(objective: number, hash: string): BeamMember {
  return { branch: `b-${hash}`, best: {} as Best, objective, noveltyHash: hash, lineage: [] };
}

describe("noveltyDistance", () => {
  it("is 0 for identical and 1 for fully different", () => {
    expect(noveltyDistance("aaaa", "aaaa")).toBe(0);
    expect(noveltyDistance("aaaa", "zzzz")).toBe(1);
    expect(noveltyDistance("aaaa", "aaab")).toBeCloseTo(0.25);
  });
});

describe("selectBeam", () => {
  it("does not collapse into near-duplicates", () => {
    const beam = selectBeam(
      [member(0.9, "aaaa"), member(0.8, "aaaa"), member(0.7, "aaaa")],
      3,
      0.15,
    );
    expect(beam).toHaveLength(1); // all identical -> only the best survives
    expect(beam[0]!.objective).toBe(0.9);
  });

  it("fills the beam with distinct members by objective", () => {
    const beam = selectBeam([member(0.9, "aaaa"), member(0.8, "bbbb"), member(0.4, "cccc")], 2, 0.15);
    expect(beam.map((m) => m.objective)).toEqual([0.9, 0.8]);
  });

  it("reserves the final slot for the most-novel member (escape local optima)", () => {
    // B is a near-duplicate of A; C is low-objective but very novel.
    const beam = selectBeam(
      [member(0.9, "aaaa"), member(0.85, "aaab"), member(0.5, "zzzz")],
      2,
      0.15,
    );
    const hashes = beam.map((m) => m.noveltyHash);
    expect(hashes).toContain("aaaa"); // the best is always kept
    expect(hashes).toContain("zzzz"); // the novel member takes the reserved slot
    expect(hashes).not.toContain("aaab");
  });
});

// --- novelty guard + reflector ---------------------------------------------

function hyp(rationale: string, parentBeam = 0): Hypothesis {
  return { id: rationale.slice(0, 6), parentBeam, rationale };
}

describe("dropDuplicates", () => {
  it("drops ideas too similar to the backlog and within the batch", () => {
    const backlog = [hyp("tighten the security reviewer trigger phrase")];
    const proposed = [
      hyp("tighten the security reviewer trigger phrase"), // dup of backlog
      hyp("add a brand new response caching layer"), // fresh
      hyp("add a brand new response caching layer"), // intra-batch dup
    ];
    const { fresh, duplicates } = dropDuplicates(proposed, backlog, 0.8);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.rationale).toMatch(/caching/);
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every((d) => d.status === "duplicate")).toBe(true);
  });
});

describe("reflect", () => {
  it("records held/failed learnings and a journal block", () => {
    const r = reflect(
      3,
      [
        { hypothesis: hyp("idea A"), verdict: { kind: "accept", objective: 0.8, gain: 0.3 } },
        { hypothesis: hyp("idea B"), verdict: { kind: "reject", reason: "insufficient-gain", detail: "noise" } },
      ],
      0.8,
    );
    expect(r.reflected[0]).toMatchObject({ status: "held", round: 3 });
    expect(r.reflected[1]).toMatchObject({ status: "failed" });
    expect(r.journal).toMatch(/## Round 3/);
    expect(r.journal).toMatch(/\[held\]/);
    expect(r.journal).toMatch(/\[failed\]/);
  });
});

// --- integration ------------------------------------------------------------

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-research-"));
  await exec("git", ["-C", dir, "init", "-q"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await writeFile(path.join(dir, ".claude", "CLAUDE.md"), "base");
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

async function branchCommitCount(repo: string, branch: string): Promise<number> {
  const { stdout } = await exec("git", ["-C", repo, "rev-list", "--count", branch]);
  return Number(stdout.trim());
}

const PROGRAM_MD = `## Objective
improve it
## Mutable surface
allow:
  - .claude/**
## Fitness
suite: train
holdout: holdout
safety: safety
k_screen: 3
k_confirm: 12
accept:
  min_objective_gain: 0.05
`;

async function loadProg(): Promise<Program> {
  const dir = await mkdtemp(path.join(tmpdir(), "crucible-prog-"));
  const file = path.join(dir, "PROGRAM.md");
  await writeFile(file, PROGRAM_MD);
  return loadProgram(file);
}

function result(name: string, passes: number, k: number, cost = 0.01): ScenarioResult {
  const trials: TrialResult[] = Array.from({ length: k }, (_, i) => ({
    index: i,
    assertions: [],
    passed: i < passes,
    costUsd: cost,
    durationMs: 1,
  }));
  return { name, trials, passRate: passes / k, stable: passes === k, medianCostUsd: cost, gatePassed: true, gateReason: "" };
}

// train improves each round; holdout flat; safety stable
const score: ScoreFn = async ({ scenarioDir, k, iter }) => {
  if (scenarioDir === "safety") return [result("sec", k, k)];
  if (scenarioDir === "holdout") return [result("h", 6, k)];
  const passes = iter === 0 ? 6 : iter === 1 ? 9 : 11;
  return [result("s", passes, k)];
};

// edits a distinct file per hypothesis so each candidate config is distinct
const editFromIdea: EditorFn = async (wt, ctx) => {
  await writeFile(path.join(wt.configDir, "note.md"), `r${ctx.iter}-${ctx.hypothesis ?? ""}`);
  return { message: `applied ${ctx.hypothesis ?? "?"}`, costUsd: 0 };
};

const validCandidate = (name: string): CandidateScenario => ({
  name,
  filename: `synth-${name}.scenario.yaml`,
  yaml: `name: ${name}\nprompt: do a hard thing\nassert:\n  - response_contains: x\n`,
});

const twoIdeas: IdeatorFn = async (beam, round) => [
  { id: `r${round}-a`, parentBeam: 0, rationale: `idea ${round}.0` },
  { id: `r${round}-b`, parentBeam: Math.min(1, beam.length - 1), rationale: `idea ${round}.1` },
];

describe("research loop", () => {
  it("runs a population search, makes progress, and bounds the beam", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const ledgerPath = path.join(await mkdtemp(path.join(tmpdir(), "led-")), "r.jsonl");

    const summary = await research({
      configDir: path.join(dir, ".claude"),
      program,
      editor: editFromIdea,
      score,
      ideator: twoIdeas,
      beamWidth: 3,
      maxRounds: 2,
      diversityFloor: 0.05,
      runId: "t",
      budgetUsd: 1000,
      ledgerPath,
    });

    expect(summary.rounds).toBe(2);
    expect(summary.bestObjective).toBeGreaterThan(summary.baselineObjective);
    expect(summary.beam.length).toBeGreaterThanOrEqual(1);
    expect(summary.beam.length).toBeLessThanOrEqual(3);
    // the winning lineage really has accepted commits on top of the seed
    expect(await branchCommitCount(dir, summary.bestBranch)).toBeGreaterThanOrEqual(2);
    // one ledger line per round
    const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    expect(ledger).toHaveLength(2);
  });

  it("writes the research journal and the idea backlog", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const out = await mkdtemp(path.join(tmpdir(), "out-"));
    const journalPath = path.join(out, "journal.md");
    const ideasPath = path.join(out, "ideas.jsonl");

    await research({
      configDir: path.join(dir, ".claude"),
      program,
      editor: editFromIdea,
      score,
      ideator: twoIdeas,
      beamWidth: 3,
      maxRounds: 1,
      diversityFloor: 0.05,
      runId: "j",
      budgetUsd: 1000,
      journalPath,
      ideasPath,
    });

    expect(await readFile(journalPath, "utf8")).toMatch(/## Round 1/);
    const ideas = (await readFile(ideasPath, "utf8")).trim().split("\n");
    expect(ideas.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(ideas[0]!)).toHaveProperty("status");
  });

  it("expands the frontier when the suite saturates", async () => {
    const dir = await makeRepo();
    const trainDir = await mkdtemp(path.join(tmpdir(), "ftrain-"));
    const holdoutDir = await mkdtemp(path.join(tmpdir(), "fholdout-"));
    const progFile = path.join(await mkdtemp(path.join(tmpdir(), "fprog-")), "PROGRAM.md");
    await writeFile(
      progFile,
      `## Objective\no\n## Mutable surface\nallow:\n  - .claude/**\n## Fitness\nsuite: ${trainDir}\nholdout: ${holdoutDir}\nk_screen: 2\nk_confirm: 6\naccept:\n  min_objective_gain: 0.05\n`,
    );
    const program = await loadProgram(progFile);

    // everything passes (suite is saturated) except the weakened reference
    const satScore: ScoreFn = async ({ configDir, k }) =>
      configDir.includes("crucible-weak") ? [result("x", 0, k)] : [result("x", k, k)];
    const synth: SynthesizeFn = async () => [validCandidate("hard1")];

    const summary = await research({
      configDir: path.join(dir, ".claude"),
      program,
      editor: editFromIdea,
      score: satScore,
      ideator: twoIdeas,
      beamWidth: 3,
      maxRounds: 1,
      diversityFloor: 0.05,
      runId: "fx",
      budgetUsd: 1000,
      synthesize: synth,
      expandEvery: 1,
      saturation: 0.95,
    });

    expect(summary.records[0]!.frontierAdded).toBeGreaterThanOrEqual(1);
    const written = await readdir(trainDir);
    expect(written).toContain("synth-hard1.scenario.yaml");
  });

  it("halts before any round when the budget is exhausted by the seed", async () => {
    const dir = await makeRepo();
    const program = await loadProg();
    const summary = await research({
      configDir: path.join(dir, ".claude"),
      program,
      editor: editFromIdea,
      score,
      ideator: twoIdeas,
      beamWidth: 3,
      maxRounds: 5,
      diversityFloor: 0.05,
      runId: "t2",
      budgetUsd: 0.05, // seed scoring (train+holdout) already exceeds this
    });
    expect(summary.rounds).toBe(0);
    expect(summary.bestObjective).toBe(summary.baselineObjective);
  });
});
