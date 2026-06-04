/**
 * Core shared types for Crucible.
 *
 * A "scenario" is one behavioral test against a Claude Code config. It is run
 * `trials` times; each run produces a `TrialResult`. Assertions are evaluated
 * per trial, then aggregated into a `ScenarioResult` with pass@k / pass^k stats.
 */

export type AssertionStatus = "pass" | "fail" | "error";

export interface AssertionResult {
  readonly kind: string;
  readonly status: AssertionStatus;
  readonly message: string;
  /** Real model cost incurred by this assertion (judge); summed into trial cost. */
  readonly costUsd?: number;
}

/** The structured envelope returned by `claude -p --output-format json`. */
export interface HeadlessResult {
  readonly result: string;
  readonly isError: boolean;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly totalCostUsd: number;
  readonly sessionId: string;
}

/** One invocation captured: the headless envelope plus the tool/subagent log. */
export interface TrialRun {
  readonly headless: HeadlessResult;
  /** Tool/subagent/skill invocations captured by the injected hooks. */
  readonly invocations: ReadonlyArray<Invocation>;
  /** Absolute path to the isolated working copy this trial ran in. */
  readonly workdir: string;
}

export interface Invocation {
  readonly type: "tool" | "subagent";
  readonly name: string;
  /** Short, human-readable summary of the tool input (command/file/etc). */
  readonly summary?: string;
}

export interface TrialResult {
  readonly index: number;
  readonly assertions: ReadonlyArray<AssertionResult>;
  readonly passed: boolean;
  readonly costUsd: number;
  readonly durationMs: number;
  /** Set when the run itself failed (claude crashed, timeout) before assertions. */
  readonly runError?: string;
}

export interface ScenarioResult {
  readonly name: string;
  readonly trials: ReadonlyArray<TrialResult>;
  /** Fraction of trials that passed all assertions, in [0, 1]. */
  readonly passRate: number;
  /** True only if every trial passed (pass^k). */
  readonly stable: boolean;
  readonly medianCostUsd: number;
  /** True when the scenario's gate (min_pass_rate / max_cost) was satisfied. */
  readonly gatePassed: boolean;
  readonly gateReason: string;
}
