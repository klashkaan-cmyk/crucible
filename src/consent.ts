/**
 * Install/first-use consent gate. Crucible will not run until the user has
 * accepted the Terms (TERMS.md). Acceptance is recorded once in the local
 * config and never asked again.
 *
 * Why first-run and not install-time: npm install scripts are routinely skipped
 * (`--ignore-scripts`) and run with no TTY (CI), so an install-time prompt is
 * not enforceable. The postinstall step *surfaces* the terms; this gate
 * *enforces* them at the point we control -- our own CLI.
 */

import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig, type TelemetryConfig } from "./telemetry.js";

export const TERMS_SUMMARY =
  "By using Crucible you agree to its Terms & Conditions (TERMS.md) and MIT\n" +
  "License. In short: Crucible sends ANONYMOUS usage statistics (CLI version,\n" +
  "OS, command, pass/fail counts) to help improve the tool. It NEVER collects\n" +
  "your prompts, file contents, paths, or results. You can opt out of telemetry\n" +
  "anytime with `crucible telemetry off` (or CRUCIBLE_TELEMETRY=0 / DO_NOT_TRACK=1).\n" +
  "Full terms: https://github.com/klashkaan-cmyk/crucible/blob/main/TERMS.md";

/** True when consent is already satisfied (stored, or forced via env). */
export function consentSatisfied(
  cfg: TelemetryConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const agree = (env.CRUCIBLE_AGREE ?? "").toLowerCase();
  if (agree === "1" || agree === "true" || agree === "yes") return true;
  return cfg.termsAccepted === true;
}

export interface ConsentDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly prompt?: (question: string) => Promise<string>;
}

/**
 * Ensure the user has accepted the terms. Returns the (possibly updated) config
 * when consent holds. Throws `ConsentDeclined` when an interactive user
 * declines, so the caller can exit cleanly without running anything.
 *
 * Non-interactive (CI, no TTY): the terms are printed and use proceeds, because
 * running Crucible in that context is itself the act of acceptance, exactly as
 * stated in the terms. Telemetry remains opt-out via the documented env vars.
 */
export async function ensureConsent(deps: ConsentDeps = {}): Promise<TelemetryConfig> {
  const env = deps.env ?? process.env;
  const cfg = await loadConfig();
  if (consentSatisfied(cfg, env)) return cfg;

  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  process.stderr.write(`\n${TERMS_SUMMARY}\n\n`);

  if (!isTTY) {
    process.stderr.write(
      "Non-interactive session detected: continued use constitutes acceptance.\n" +
        "To accept explicitly in scripts, set CRUCIBLE_AGREE=1.\n\n",
    );
    return persistAccepted(cfg);
  }

  const ask = deps.prompt ?? defaultPrompt;
  const answer = (await ask("Type 'yes' to accept and continue: ")).trim().toLowerCase();
  if (answer !== "yes" && answer !== "y") {
    throw new ConsentDeclined();
  }
  return persistAccepted(cfg);
}

export class ConsentDeclined extends Error {
  constructor() {
    super("Terms not accepted");
    this.name = "ConsentDeclined";
  }
}

/** Record explicit acceptance (used by `crucible agree`). */
export async function acceptTerms(): Promise<void> {
  const cfg = await loadConfig();
  await persistAccepted(cfg);
}

async function persistAccepted(cfg: TelemetryConfig): Promise<TelemetryConfig> {
  if (cfg.termsAccepted) return cfg;
  const next = { ...cfg, termsAccepted: true };
  await saveConfig(next);
  return next;
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
