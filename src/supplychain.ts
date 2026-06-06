/**
 * `crucible scan` -- supply-chain exposure scan of a `.claude` config.
 *
 * Where `lint` checks that a config is well-formed and `run` checks that it
 * *behaves*, `scan` checks that it does not pull in a *known-compromised*
 * component: a flagged MCP server, a poisoned agent skill, or a malicious npm
 * dependency. It reads on-disk metadata only -- no package managers are
 * executed, no source is analyzed, no model is called (zero cost, deterministic).
 *
 * The catalog format and the NDJSON record shapes are intentionally compatible
 * with Perplexity's Bumblebee inventory scanner (https://github.com/perplexityai/bumblebee,
 * Apache-2.0), so a Bumblebee-published exposure catalog can drive a Crucible CI
 * gate and Crucible findings can flow into the same tooling. This is a
 * clean-room TypeScript reimplementation of the catalog/matching approach scoped
 * to a single config-under-test (not a machine-wide filesystem walk).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./lint.js";

export const SCHEMA_VERSION = "0.1.0";
export const SCANNER_NAME = "crucible";
export const SCANNER_VERSION = "0.7.0";

export type Ecosystem = "mcp" | "agent-skill" | "npm";
export type Confidence = "high" | "medium" | "low";
export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly ecosystem: string;
  readonly package: string;
  readonly versions?: readonly string[];
  readonly severity: Severity;
}

export interface ExposureCatalog {
  readonly schema_version: string;
  readonly entries: readonly CatalogEntry[];
}

export interface Component {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version?: string;
  readonly sourceType: string;
  readonly sourceFile: string;
  readonly confidence: Confidence;
}

export interface Finding {
  readonly findingType: "package_exposure";
  readonly severity: Severity;
  readonly catalogId: string;
  readonly catalogName: string;
  readonly ecosystem: string;
  readonly packageName: string;
  readonly version?: string;
  readonly evidence: string;
}

export interface ScanResult {
  readonly components: readonly Component[];
  readonly findings: readonly Finding[];
  readonly catalogEntries: number;
}

// ---------------------------------------------------------------------------
// Package-spec extraction (MCP servers usually launch via `npx -y pkg@version`)
// ---------------------------------------------------------------------------

const SPEC_RE = /^((?:@[^@/\s]+\/)?[^@/\s][^@\s]*?)@(\d[\w.+-]*)$/;

/** Pull a pinned `name@version` npm spec out of a command + args, if present. */
export function extractPackageSpec(
  command: string,
  args: readonly string[],
): { name: string; version: string } | null {
  for (const tok of [command, ...args]) {
    if (typeof tok !== "string" || tok.startsWith("-")) continue;
    const m = tok.match(SPEC_RE);
    if (m && m[1] && m[2]) return { name: m[1], version: m[2] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Catalog parsing / merging
// ---------------------------------------------------------------------------

const SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "info"]);

function normalizeSeverity(s: string): Severity {
  const v = s.toLowerCase();
  return (SEVERITIES.has(v) ? v : "medium") as Severity;
}

function parseEntry(e: unknown, i: number): CatalogEntry {
  if (!e || typeof e !== "object") throw new Error(`catalog entry ${i} is not an object`);
  const r = e as Record<string, unknown>;
  for (const k of ["id", "ecosystem", "package", "severity"] as const) {
    if (typeof r[k] !== "string") throw new Error(`catalog entry ${i} missing string \`${k}\``);
  }
  let versions: string[] | undefined;
  if (r.versions !== undefined) {
    if (!Array.isArray(r.versions)) throw new Error(`catalog entry ${i} \`versions\` must be an array`);
    versions = r.versions.filter((v): v is string => typeof v === "string");
  }
  return {
    id: r.id as string,
    name: typeof r.name === "string" ? r.name : (r.package as string),
    ecosystem: r.ecosystem as string,
    package: r.package as string,
    severity: normalizeSeverity(r.severity as string),
    ...(versions ? { versions } : {}),
  };
}

/** Validate and normalize an exposure catalog object (throws on malformed input). */
export function parseCatalog(data: unknown): ExposureCatalog {
  if (!data || typeof data !== "object") throw new Error("catalog must be a JSON object");
  const d = data as Record<string, unknown>;
  if (typeof d.schema_version !== "string") throw new Error("catalog missing string `schema_version`");
  if (!Array.isArray(d.entries)) throw new Error("catalog missing `entries` array");
  return { schema_version: d.schema_version, entries: d.entries.map(parseEntry) };
}

function mergeCatalogs(catalogs: readonly ExposureCatalog[]): ExposureCatalog {
  const first = catalogs[0];
  if (!first) return { schema_version: SCHEMA_VERSION, entries: [] };
  for (const c of catalogs) {
    if (c.schema_version !== first.schema_version) {
      throw new Error(
        `catalog schema_version mismatch: ${first.schema_version} vs ${c.schema_version} (all catalogs in a directory must agree)`,
      );
    }
  }
  return { schema_version: first.schema_version, entries: catalogs.flatMap((c) => c.entries) };
}

/** Load a catalog from a JSON file, or merge every `*.json` in a directory. */
export async function loadCatalog(fileOrDir: string): Promise<ExposureCatalog> {
  const info = await stat(fileOrDir);
  if (info.isDirectory()) {
    const files = (await readdir(fileOrDir))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => path.join(fileOrDir, f));
    const cats: ExposureCatalog[] = [];
    for (const f of files) cats.push(parseCatalog(JSON.parse(await readFile(f, "utf8"))));
    return mergeCatalogs(cats);
  }
  return parseCatalog(JSON.parse(await readFile(fileOrDir, "utf8")));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Exact `(ecosystem, package, version)` matching, Bumblebee-style. */
export function matchExposures(
  components: readonly Component[],
  catalog: ExposureCatalog,
): Finding[] {
  const out: Finding[] = [];
  for (const c of components) {
    for (const e of catalog.entries) {
      if (e.ecosystem !== c.ecosystem || e.package !== c.name) continue;
      const versions = e.versions;
      if (!versions || versions.length === 0) {
        out.push(makeFinding(e, c, "name match (catalog lists no specific version)"));
      } else if (c.version !== undefined && versions.includes(c.version)) {
        out.push(makeFinding(e, c, `exact name+version match (version=${c.version})`));
      }
    }
  }
  return out;
}

function makeFinding(e: CatalogEntry, c: Component, evidence: string): Finding {
  return {
    findingType: "package_exposure",
    severity: e.severity,
    catalogId: e.id,
    catalogName: e.name,
    ecosystem: c.ecosystem,
    packageName: c.name,
    evidence,
    ...(c.version !== undefined ? { version: c.version } : {}),
  };
}

// ---------------------------------------------------------------------------
// Severity helpers (for the --fail-on gate)
// ---------------------------------------------------------------------------

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityRank(s: string): number {
  return SEVERITY_RANK[normalizeSeverity(s)];
}

export function hasFindingAtOrAbove(findings: readonly Finding[], threshold: string): boolean {
  const t = severityRank(threshold);
  return findings.some((f) => severityRank(f.severity) >= t);
}

export function maxSeverity(findings: readonly Finding[]): Severity | null {
  let best: Severity | null = null;
  for (const f of findings) {
    if (best === null || severityRank(f.severity) > severityRank(best)) best = f.severity;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Inventory (read-only, config-scoped)
// ---------------------------------------------------------------------------

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<unknown | null> {
  const raw = await readText(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function inventorySkills(dir: string, out: Component[]): Promise<void> {
  const skillsDir = path.join(dir, "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(skillsDir, entry, "SKILL.md");
    const raw = await readText(file);
    if (raw === null) continue;
    const fm = parseFrontmatter(raw);
    if (!fm) continue;
    const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : entry;
    const version =
      typeof fm.version === "string" ? fm.version.trim() : typeof fm.version === "number" ? String(fm.version) : undefined;
    out.push({
      ecosystem: "agent-skill",
      name,
      sourceType: "skill-frontmatter",
      sourceFile: file,
      confidence: version ? "high" : "low",
      ...(version ? { version } : {}),
    });
  }
}

async function inventoryMcp(dir: string, out: Component[]): Promise<void> {
  const files = [
    path.join(dir, "..", ".mcp.json"),
    path.join(dir, ".mcp.json"),
    path.join(dir, "settings.json"),
    path.join(dir, "settings.local.json"),
  ];
  const seen = new Set<string>();
  for (const file of files) {
    const data = await readJson(file);
    const servers = (data as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, cfg] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const c = cfg as { command?: unknown; args?: unknown };
      const command = typeof c.command === "string" ? c.command : "";
      const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === "string") : [];
      const spec = extractPackageSpec(command, args);
      out.push({
        ecosystem: "mcp",
        name,
        sourceType: "mcp-config",
        sourceFile: file,
        confidence: spec ? "high" : "low",
        ...(spec ? { version: spec.version } : {}),
      });
      if (spec) {
        out.push({
          ecosystem: "npm",
          name: spec.name,
          version: spec.version,
          sourceType: "mcp-server-package",
          sourceFile: file,
          confidence: "high",
        });
      }
    }
  }
}

async function inventoryNpm(dir: string, out: Component[]): Promise<void> {
  for (const file of [path.join(dir, "..", "package-lock.json"), path.join(dir, "package-lock.json")]) {
    const data = await readJson(file);
    if (!data || typeof data !== "object") continue;
    const packages = (data as { packages?: Record<string, unknown> }).packages;
    const seen = new Set<string>();
    const push = (name: string, version: string | undefined): void => {
      if (!name) return;
      const key = `${name}@${version ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        ecosystem: "npm",
        name,
        sourceType: "npm-lockfile",
        sourceFile: file,
        confidence: "high",
        ...(version ? { version } : {}),
      });
    };
    if (packages && typeof packages === "object") {
      for (const [pkgPath, val] of Object.entries(packages)) {
        if (!pkgPath) continue; // the "" root project entry
        const marker = "node_modules/";
        const idx = pkgPath.lastIndexOf(marker);
        const name = idx >= 0 ? pkgPath.slice(idx + marker.length) : pkgPath;
        const version = typeof (val as { version?: unknown })?.version === "string" ? (val as { version: string }).version : undefined;
        push(name, version);
      }
    } else {
      const deps = (data as { dependencies?: Record<string, unknown> }).dependencies;
      if (deps && typeof deps === "object") {
        for (const [name, val] of Object.entries(deps)) {
          const version = typeof (val as { version?: unknown })?.version === "string" ? (val as { version: string }).version : undefined;
          push(name, version);
        }
      }
    }
  }
}

/** Read-only inventory of a config's supply-chain surface. */
export async function inventory(configDir: string): Promise<Component[]> {
  const out: Component[] = [];
  await inventorySkills(configDir, out);
  await inventoryMcp(configDir, out);
  await inventoryNpm(configDir, out);
  return out;
}

/** Inventory a config and, if a catalog is given, match it for known exposures. */
export async function scanConfig(configDir: string, catalogPath?: string): Promise<ScanResult> {
  const components = await inventory(configDir);
  if (!catalogPath) return { components, findings: [], catalogEntries: 0 };
  const catalog = await loadCatalog(catalogPath);
  return { components, findings: matchExposures(components, catalog), catalogEntries: catalog.entries.length };
}

// ---------------------------------------------------------------------------
// NDJSON output (Bumblebee-compatible records)
// ---------------------------------------------------------------------------

export interface NdjsonMeta {
  readonly scanTime?: string;
  readonly profile?: string;
  readonly runId?: string;
}

/** Serialize an inventory + findings as newline-delimited JSON records. */
export function toNdjson(
  components: readonly Component[],
  findings: readonly Finding[],
  meta: NdjsonMeta = {},
): string {
  const base = {
    schema_version: SCHEMA_VERSION,
    scanner_name: SCANNER_NAME,
    scanner_version: SCANNER_VERSION,
    scan_time: meta.scanTime ?? new Date().toISOString(),
    ...(meta.profile ? { profile: meta.profile } : {}),
    ...(meta.runId ? { run_id: meta.runId } : {}),
  };
  const lines: string[] = [];
  for (const c of components) {
    lines.push(
      JSON.stringify({
        record_type: "package",
        ...base,
        ecosystem: c.ecosystem,
        package_name: c.name,
        ...(c.version ? { version: c.version } : {}),
        source_type: c.sourceType,
        source_file: c.sourceFile,
        confidence: c.confidence,
      }),
    );
  }
  for (const f of findings) {
    lines.push(
      JSON.stringify({
        record_type: "finding",
        ...base,
        finding_type: f.findingType,
        severity: f.severity,
        catalog_id: f.catalogId,
        catalog_name: f.catalogName,
        ecosystem: f.ecosystem,
        package_name: f.packageName,
        ...(f.version ? { version: f.version } : {}),
        evidence: f.evidence,
      }),
    );
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}
