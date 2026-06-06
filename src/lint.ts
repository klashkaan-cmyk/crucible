/**
 * `crucible lint` -- deterministic, offline static checks on a `.claude` config.
 * No model calls, no cost. Catches the config mistakes that silently degrade an
 * agent: empty skill descriptions (won't auto-activate), duplicate subagent
 * names, hooks pointing at missing scripts, secrets committed in CLAUDE.md, and
 * bloated CLAUDE.md files.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { findSecret } from "./secrets.js";
import { scanConfig } from "./supplychain.js";

export type LintLevel = "error" | "warn" | "info";

export interface LintFinding {
  readonly rule: string;
  readonly level: LintLevel;
  readonly message: string;
  readonly file: string;
}

export interface LintOptions {
  /**
   * Path to an exposure catalog (a JSON file or a directory of them). When set,
   * lint also flags known-compromised components. When omitted, a `threat_intel/`
   * directory next to the config is auto-discovered if present.
   */
  readonly exposureCatalog?: string;
}

const CLAUDE_MD_WARN_BYTES = 20_000;

export async function lintConfig(dir: string, opts: LintOptions = {}): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  await lintSettings(dir, findings);
  await lintAgents(dir, findings);
  await lintSkills(dir, findings);
  await lintClaudeMd(dir, findings);
  await lintSecrets(dir, findings);
  await lintSupplyChain(dir, opts.exposureCatalog, findings);
  return findings;
}

/** Extract YAML frontmatter (between leading `---` fences) as an object. */
export function parseFrontmatter(text: string): Record<string, unknown> | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  try {
    const obj = parseYaml(m[1]!);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function listFiles(dir: string, filter: (name: string) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(filter).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function lintSettings(dir: string, out: LintFinding[]): Promise<void> {
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = path.join(dir, name);
    const raw = await readIfExists(file);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      out.push({ rule: "settings-json", level: "error", file, message: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    await lintHooks(parsed, dir, file, out);
  }
}

async function lintHooks(settings: unknown, dir: string, file: string, out: LintFinding[]): Promise<void> {
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks;
  if (!hooks || typeof hooks !== "object") return;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const list = (group as { hooks?: unknown[] })?.hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const cmd = (h as { command?: string })?.command;
        if (typeof cmd !== "string") continue;
        const ref = scriptRef(cmd);
        if (ref && !(await scriptExists(ref, dir))) {
          out.push({ rule: "hook-missing-script", level: "warn", file, message: `hook references a script that does not exist: ${ref}` });
        }
      }
    }
  }
}

/** Pull a script path out of a hook command, if it clearly references one. */
function scriptRef(cmd: string): string | null {
  const m = cmd.match(/(\$CLAUDE_PROJECT_DIR\/|\.\/|\/)?[\w./-]+\.(?:sh|py|js|mjs|ts)\b/);
  return m ? m[0] : null;
}

async function scriptExists(ref: string, dir: string): Promise<boolean> {
  const cleaned = ref.replace("$CLAUDE_PROJECT_DIR/", "").replace(/^\.\//, "");
  for (const base of [dir, path.dirname(dir), path.join(dir, "..")]) {
    try {
      await stat(path.resolve(base, cleaned));
      return true;
    } catch {
      // keep looking
    }
  }
  return path.isAbsolute(ref) ? await stat(ref).then(() => true).catch(() => false) : false;
}

async function lintAgents(dir: string, out: LintFinding[]): Promise<void> {
  const files = await listFiles(path.join(dir, "agents"), (f) => f.endsWith(".md"));
  const names = new Map<string, string>();
  for (const file of files) {
    const fm = parseFrontmatter((await readIfExists(file)) ?? "");
    if (!fm) {
      out.push({ rule: "agent-frontmatter", level: "error", file, message: "missing or invalid YAML frontmatter" });
      continue;
    }
    const name = typeof fm.name === "string" ? fm.name.trim() : "";
    if (!name) out.push({ rule: "agent-name", level: "error", file, message: "subagent has no `name`" });
    if (!String(fm.description ?? "").trim()) {
      out.push({ rule: "agent-description", level: "warn", file, message: "subagent has no `description` (the model uses it to decide when to delegate)" });
    }
    if (name) {
      const prev = names.get(name);
      if (prev) out.push({ rule: "agent-duplicate-name", level: "error", file, message: `duplicate subagent name '${name}' (also in ${path.basename(prev)})` });
      else names.set(name, file);
    }
  }
}

async function lintSkills(dir: string, out: LintFinding[]): Promise<void> {
  const skillsDir = path.join(dir, "skills");
  let entries: string[] = [];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(skillsDir, entry, "SKILL.md");
    const raw = await readIfExists(file);
    if (raw === null) continue;
    const fm = parseFrontmatter(raw);
    if (!fm) {
      out.push({ rule: "skill-frontmatter", level: "error", file, message: "missing or invalid YAML frontmatter" });
      continue;
    }
    if (!String(fm.name ?? "").trim()) out.push({ rule: "skill-name", level: "error", file, message: "skill has no `name`" });
    if (!String(fm.description ?? "").trim()) {
      out.push({ rule: "skill-description", level: "warn", file, message: "skill has no `description` -- it will not auto-activate" });
    }
  }
}

async function lintClaudeMd(dir: string, out: LintFinding[]): Promise<void> {
  for (const file of [path.join(dir, "CLAUDE.md"), path.join(dir, "..", "CLAUDE.md")]) {
    try {
      const info = await stat(file);
      if (info.size > CLAUDE_MD_WARN_BYTES) {
        out.push({ rule: "claude-md-size", level: "warn", file, message: `CLAUDE.md is ${(info.size / 1024).toFixed(0)}KB; large context files dilute attention (consider trimming)` });
      }
    } catch {
      // no CLAUDE.md here
    }
  }
}

async function lintSecrets(dir: string, out: LintFinding[]): Promise<void> {
  const candidates = [
    path.join(dir, "CLAUDE.md"),
    path.join(dir, "..", "CLAUDE.md"),
    path.join(dir, "settings.json"),
    ...(await listFiles(path.join(dir, "agents"), (f) => f.endsWith(".md"))),
  ];
  for (const file of candidates) {
    const raw = await readIfExists(file);
    if (raw === null) continue;
    const hit = findSecret(raw);
    if (hit) out.push({ rule: "secret", level: "error", file, message: `possible hardcoded ${hit.name} -- move it to an env var / secret manager` });
  }
}

/**
 * Supply-chain provenance check: flag config components (MCP servers, agent
 * skills, npm deps) that appear in a known-exposure catalog. Reuses the same
 * scanner as `crucible scan` / the `no_known_exposure` assertion.
 */
async function lintSupplyChain(
  dir: string,
  explicitCatalog: string | undefined,
  out: LintFinding[],
): Promise<void> {
  const catalog = explicitCatalog ?? (await discoverCatalog(dir));
  if (!catalog) return;
  try {
    const { components, findings } = await scanConfig(dir, catalog);
    const sourceByKey = new Map<string, string>();
    for (const c of components) sourceByKey.set(`${c.ecosystem}|${c.name}|${c.version ?? ""}`, c.sourceFile);
    for (const f of findings) {
      const file = sourceByKey.get(`${f.ecosystem}|${f.packageName}|${f.version ?? ""}`) ?? catalog;
      out.push({
        rule: "supply-chain-exposure",
        level: severityToLevel(f.severity),
        file,
        message: `known-compromised ${f.ecosystem} '${f.packageName}${f.version ? "@" + f.version : ""}' (${f.severity}, ${f.catalogId}): ${f.evidence}`,
      });
    }
  } catch (err) {
    out.push({
      rule: "supply-chain-catalog",
      level: "warn",
      file: catalog,
      message: `exposure catalog could not be loaded: ${(err as Error).message.slice(0, 120)}`,
    });
  }
}

function severityToLevel(sev: string): LintLevel {
  if (sev === "critical" || sev === "high") return "error";
  if (sev === "medium") return "warn";
  return "info";
}

/** Auto-discover a `threat_intel/` catalog directory next to the config. */
async function discoverCatalog(dir: string): Promise<string | undefined> {
  for (const c of [path.join(dir, "..", "threat_intel"), path.join(dir, "threat_intel")]) {
    try {
      if ((await stat(c)).isDirectory()) return c;
    } catch {
      // not here -> keep looking
    }
  }
  return undefined;
}

export function countByLevel(findings: ReadonlyArray<LintFinding>): Record<LintLevel, number> {
  return {
    error: findings.filter((f) => f.level === "error").length,
    warn: findings.filter((f) => f.level === "warn").length,
    info: findings.filter((f) => f.level === "info").length,
  };
}
