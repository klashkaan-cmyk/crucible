/**
 * `crucible generate` -- scaffold a starter scenario suite from an existing
 * `.claude` config. The biggest barrier to adopting eval CI is writing the first
 * scenarios; this reads what the config already declares (subagents, skills,
 * CLAUDE.md) and emits one scenario per capability so a user goes from zero to a
 * runnable suite in one command.
 *
 * The discovery (filesystem) and the rendering (pure) are separated so the
 * rendering is unit-testable without a config on disk.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./lint.js";

export interface ConfigSummary {
  readonly subagents: ReadonlyArray<{ name: string; description: string }>;
  readonly skills: ReadonlyArray<{ name: string; description: string }>;
  readonly hasClaudeMd: boolean;
}

export interface GeneratedScenario {
  readonly filename: string;
  readonly yaml: string;
}

/** Read a `.claude` dir into a structured summary (best-effort, never throws). */
export async function summarizeConfig(dir: string): Promise<ConfigSummary> {
  const subagents = await readSubagents(path.join(dir, "agents"));
  const skills = await readSkills(path.join(dir, "skills"));
  const hasClaudeMd = await exists(path.join(dir, "CLAUDE.md")) || await exists(path.join(dir, "..", "CLAUDE.md"));
  return { subagents, skills, hasClaudeMd };
}

async function readSubagents(agentsDir: string): Promise<Array<{ name: string; description: string }>> {
  const out: Array<{ name: string; description: string }> = [];
  let files: string[];
  try {
    files = (await readdir(agentsDir)).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const fm = parseFrontmatter(await readFile(path.join(agentsDir, f), "utf8").catch(() => ""));
    const name = fm && typeof fm.name === "string" ? fm.name.trim() : "";
    if (!name) continue;
    out.push({ name, description: fm && typeof fm.description === "string" ? fm.description.trim() : "" });
  }
  return out;
}

async function readSkills(skillsDir: string): Promise<Array<{ name: string; description: string }>> {
  const out: Array<{ name: string; description: string }> = [];
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const fm = parseFrontmatter(
      await readFile(path.join(skillsDir, entry, "SKILL.md"), "utf8").catch(() => ""),
    );
    const name = fm && typeof fm.name === "string" ? fm.name.trim() : "";
    if (!name) continue;
    out.push({ name, description: fm && typeof fm.description === "string" ? fm.description.trim() : "" });
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/** YAML-escape a string for use as a double-quoted scalar. */
function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A short, human prompt derived from a capability description. */
function promptFor(description: string, fallback: string): string {
  const d = description.trim();
  if (!d) return fallback;
  // First sentence, trimmed to a reasonable length.
  const first = d.split(/(?<=[.!?])\s/)[0] ?? d;
  return first.length > 160 ? first.slice(0, 157) + "..." : first;
}

/** Render the scenarios implied by a config summary. Pure; no I/O. */
export function renderScenarios(summary: ConfigSummary): GeneratedScenario[] {
  const scenarios: GeneratedScenario[] = [];

  for (const a of summary.subagents) {
    const prompt = promptFor(a.description, `Do a task that should be handled by the ${a.name} subagent.`);
    scenarios.push({
      filename: `subagent-${slug(a.name)}.scenario.yaml`,
      yaml:
        `# Auto-generated: verifies the '${a.name}' subagent activates for relevant work.\n` +
        `# Review the prompt -- generated prompts are a starting point, not ground truth.\n` +
        `name: subagent-${slug(a.name)}-activates\n` +
        `prompt: |\n  ${prompt}\n` +
        `trials: 3\n` +
        `assert:\n` +
        `  - subagent_invoked: ${a.name}\n` +
        `gate:\n` +
        `  min_pass_rate: 0.67\n`,
    });
  }

  for (const s of summary.skills) {
    const prompt = promptFor(s.description, `Do a task that should trigger the ${s.name} skill.`);
    scenarios.push({
      filename: `skill-${slug(s.name)}.scenario.yaml`,
      yaml:
        `# Auto-generated: a smoke test for the '${s.name}' skill. Tighten the assertions\n` +
        `# (e.g. file_matches, response_contains) to match what the skill should produce.\n` +
        `name: skill-${slug(s.name)}-smoke\n` +
        `prompt: |\n  ${prompt}\n` +
        `trials: 2\n` +
        `assert:\n` +
        `  - cost_under: 1.00\n` +
        `gate:\n` +
        `  min_pass_rate: 1\n`,
    });
  }

  if (summary.hasClaudeMd) {
    scenarios.push({
      filename: `claude-md-smoke.scenario.yaml`,
      yaml:
        `# Auto-generated: a minimal smoke test that the config responds coherently.\n` +
        `# Replace the judge rubric with something specific to your CLAUDE.md rules.\n` +
        `name: claude-md-smoke\n` +
        `prompt: |\n  Briefly introduce what you can help with in this project.\n` +
        `trials: 1\n` +
        `assert:\n` +
        `  - judge: "The response is coherent and consistent with the project's CLAUDE.md guidance"\n` +
        `gate:\n` +
        `  min_pass_rate: 1\n`,
    });
  }

  return scenarios;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}
