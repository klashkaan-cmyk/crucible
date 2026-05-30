/**
 * Anonymous, opt-out telemetry. Design constraints (non-negotiable):
 *   - NEVER collect prompts, file contents, paths, scenario bodies, results,
 *     or anything user-identifying. Only coarse counts + environment facts.
 *   - Always honor DO_NOT_TRACK and CRUCIBLE_TELEMETRY=0 / off / false.
 *   - A prominent one-time notice is printed before any data leaves the host.
 *   - Network send is fail-silent and time-boxed; telemetry must never break,
 *     slow, or alter a run.
 *   - Disclosed + opt-out: events go to the project collector unless the
 *     user opts out; a one-time notice is shown before anything is sent.
 *
 * See TELEMETRY.md for the full field list and rationale.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TelemetryConfig {
  enabled: boolean;
  anonymousId: string;
  noticeShown: boolean;
  /** Whether the user has accepted the Terms (see TERMS.md). */
  termsAccepted: boolean;
}

/**
 * Collector endpoint that receives the anonymous events (see TELEMETRY.md).
 * Overridable per-run with CRUCIBLE_TELEMETRY_URL (set it to "" to force
 * off-network). All opt-out controls -- `crucible telemetry off`,
 * CRUCIBLE_TELEMETRY=0, DO_NOT_TRACK=1 -- still apply regardless of this value.
 */
const DEFAULT_ENDPOINT = "https://ahmad.chatbotbuddy.net/crucible/v1/events";

const SEND_TIMEOUT_MS = 1500;

export const NOTICE =
  "Crucible collects anonymous usage stats (CLI version, OS, command, and " +
  "pass/fail counts) to help improve the tool.\n" +
  "It NEVER collects prompts, file contents, paths, or results. " +
  "Opt out anytime: `crucible telemetry off` (or CRUCIBLE_TELEMETRY=0 / " +
  "DO_NOT_TRACK=1). Details: TELEMETRY.md\n";

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "crucible");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadConfig(): Promise<TelemetryConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const obj = JSON.parse(raw) as Partial<TelemetryConfig>;
    return {
      enabled: obj.enabled ?? true,
      anonymousId: obj.anonymousId ?? randomUUID(),
      noticeShown: obj.noticeShown ?? false,
      termsAccepted: obj.termsAccepted ?? false,
    };
  } catch {
    return { enabled: true, anonymousId: randomUUID(), noticeShown: false, termsAccepted: false };
  }
}

export async function saveConfig(cfg: TelemetryConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(cfg, null, 2));
}

/** Standard kill switches, honored regardless of stored config. */
function envDisabled(env: NodeJS.ProcessEnv): boolean {
  const dnt = env.DO_NOT_TRACK;
  if (dnt && dnt !== "0" && dnt.toLowerCase() !== "false") return true;
  const v = (env.CRUCIBLE_TELEMETRY ?? "").toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

export function isEnabled(cfg: TelemetryConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envDisabled(env)) return false;
  return cfg.enabled;
}

/** Print the disclosure once, to stderr (never pollutes stdout/JUnit). */
export async function maybeShowNotice(
  cfg: TelemetryConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnabled(cfg, env) || cfg.noticeShown) return;
  process.stderr.write(`\n${NOTICE}\n`);
  await saveConfig({ ...cfg, noticeShown: true });
}

export interface TrackOptions {
  readonly version: string;
  readonly event: string;
  /** Coarse, non-identifying properties only (counts, booleans, enums). */
  readonly props?: Record<string, string | number | boolean>;
}

export async function track(
  cfg: TelemetryConfig,
  opts: TrackOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnabled(cfg, env)) return;
  const endpoint = env.CRUCIBLE_TELEMETRY_URL || DEFAULT_ENDPOINT;
  if (!endpoint) return; // dormant until a collector is configured

  const payload = {
    event: opts.event,
    anonymousId: cfg.anonymousId,
    version: opts.version,
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    ci: Boolean(env.CI),
    ts: new Date().toISOString(),
    ...sanitizeProps(opts.props ?? {}),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => undefined);
    clearTimeout(timer);
  } catch {
    // fail silent on purpose: telemetry must never affect the CLI
  }
}

/**
 * Defense in depth: even though callers only pass coarse values, coerce types
 * and drop anything path-like or oversized so a future careless call site can't
 * leak. Strings are capped and rejected if they contain path separators.
 */
export function sanitizeProps(
  props: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (typeof v === "string") {
      if (v.includes("/") || v.includes("\\") || v.length > 64) continue;
      out[k] = v;
    }
  }
  return out;
}

export async function setEnabled(enabled: boolean): Promise<TelemetryConfig> {
  const cfg = await loadConfig();
  const next = { ...cfg, enabled, noticeShown: true };
  await saveConfig(next);
  return next;
}
