import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractPackageSpec,
  parseCatalog,
  matchExposures,
  inventory,
  scanConfig,
  toNdjson,
  hasFindingAtOrAbove,
  maxSeverity,
  type Component,
  type ExposureCatalog,
} from "../src/supplychain.js";

async function tmpConfig(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "crucible-scan-"));
}

function comp(c: Partial<Component> & { ecosystem: Component["ecosystem"]; name: string }): Component {
  return {
    sourceType: "test",
    sourceFile: "test",
    confidence: "high",
    ...c,
  };
}

describe("extractPackageSpec", () => {
  it("pulls a scoped, versioned npm package out of an npx invocation", () => {
    expect(extractPackageSpec("npx", ["-y", "@scope/server-fs@2.0.0"])).toEqual({
      name: "@scope/server-fs",
      version: "2.0.0",
    });
  });
  it("pulls a bare versioned package", () => {
    expect(extractPackageSpec("npx", ["pkg@1.2.3"])).toEqual({ name: "pkg", version: "1.2.3" });
  });
  it("reads a spec on the command token itself", () => {
    expect(extractPackageSpec("some-mcp@2.0.0-beta.1", [])).toEqual({
      name: "some-mcp",
      version: "2.0.0-beta.1",
    });
  });
  it("returns null when no version is pinned", () => {
    expect(extractPackageSpec("npx", ["-y", "@scope/pkg"])).toBeNull();
  });
  it("returns null for a plain script command", () => {
    expect(extractPackageSpec("node", ["server.js"])).toBeNull();
  });
});

describe("parseCatalog", () => {
  it("parses a valid Bumblebee-shaped catalog", () => {
    const cat = parseCatalog({
      schema_version: "0.1.0",
      entries: [{ id: "a", name: "x", ecosystem: "npm", package: "x", versions: ["1.0.0"], severity: "high" }],
    });
    expect(cat.schema_version).toBe("0.1.0");
    expect(cat.entries).toHaveLength(1);
    expect(cat.entries[0]?.package).toBe("x");
  });
  it("throws when entries is missing", () => {
    expect(() => parseCatalog({ schema_version: "0.1.0" })).toThrow(/entries/);
  });
  it("throws when an entry is missing a required field", () => {
    expect(() =>
      parseCatalog({ schema_version: "0.1.0", entries: [{ id: "a", ecosystem: "npm", severity: "high" }] }),
    ).toThrow(/package/);
  });
  it("normalizes an unknown severity to medium", () => {
    const cat = parseCatalog({
      schema_version: "0.1.0",
      entries: [{ id: "a", name: "x", ecosystem: "npm", package: "x", severity: "spicy" }],
    });
    expect(cat.entries[0]?.severity).toBe("medium");
  });
});

const CATALOG: ExposureCatalog = {
  schema_version: "0.1.0",
  entries: [
    { id: "adv-1", name: "evil-skill 6.6.6", ecosystem: "agent-skill", package: "evil-skill", versions: ["6.6.6"], severity: "critical" },
    { id: "adv-2", name: "sketchy mcp", ecosystem: "mcp", package: "sketchy", severity: "high" },
    { id: "adv-3", name: "left-pad 1.0.0", ecosystem: "npm", package: "left-pad", versions: ["1.0.0"], severity: "medium" },
  ],
};

describe("matchExposures", () => {
  it("flags an exact name+version match", () => {
    const f = matchExposures([comp({ ecosystem: "agent-skill", name: "evil-skill", version: "6.6.6" })], CATALOG);
    expect(f).toHaveLength(1);
    expect(f[0]?.catalogId).toBe("adv-1");
    expect(f[0]?.severity).toBe("critical");
    expect(f[0]?.evidence).toMatch(/exact name\+version/);
  });
  it("does not flag a version mismatch", () => {
    const f = matchExposures([comp({ ecosystem: "agent-skill", name: "evil-skill", version: "1.0.0" })], CATALOG);
    expect(f).toHaveLength(0);
  });
  it("flags a name-only match when the catalog pins no version", () => {
    const f = matchExposures([comp({ ecosystem: "mcp", name: "sketchy" })], CATALOG);
    expect(f).toHaveLength(1);
    expect(f[0]?.catalogId).toBe("adv-2");
    expect(f[0]?.evidence).toMatch(/name match/);
  });
  it("does not cross ecosystems", () => {
    const f = matchExposures([comp({ ecosystem: "npm", name: "sketchy" })], CATALOG);
    expect(f).toHaveLength(0);
  });
});

describe("severity helpers", () => {
  it("gates at or above a threshold", () => {
    const f = matchExposures([comp({ ecosystem: "npm", name: "left-pad", version: "1.0.0" })], CATALOG);
    expect(hasFindingAtOrAbove(f, "high")).toBe(false); // medium < high
    expect(hasFindingAtOrAbove(f, "medium")).toBe(true);
  });
  it("reports the max severity", () => {
    const f = matchExposures(
      [
        comp({ ecosystem: "agent-skill", name: "evil-skill", version: "6.6.6" }),
        comp({ ecosystem: "npm", name: "left-pad", version: "1.0.0" }),
      ],
      CATALOG,
    );
    expect(maxSeverity(f)).toBe("critical");
  });
});

describe("inventory", () => {
  it("inventories skills, MCP servers (with embedded npm pkg), and lockfile deps", async () => {
    const dir = await tmpConfig();
    await mkdir(path.join(dir, "skills", "evil"), { recursive: true });
    await writeFile(path.join(dir, "skills", "evil", "SKILL.md"), "---\nname: evil-skill\nversion: 6.6.6\n---\nbody");
    await writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "@scope/server-fs@2.0.0"] },
          sketchy: { command: "node", args: ["server.js"] },
        },
      }),
    );
    await writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.0.0" } } }),
    );

    const items = await inventory(dir);
    const find = (eco: string, name: string): Component | undefined =>
      items.find((i) => i.ecosystem === eco && i.name === name);

    const skill = find("agent-skill", "evil-skill");
    expect(skill?.version).toBe("6.6.6");
    expect(skill?.confidence).toBe("high");

    expect(find("mcp", "fs")?.version).toBe("2.0.0");
    expect(find("mcp", "sketchy")?.confidence).toBe("low");
    expect(find("npm", "@scope/server-fs")?.version).toBe("2.0.0");
    expect(find("npm", "left-pad")?.version).toBe("1.0.0");
  });

  it("returns an empty inventory for an empty config", async () => {
    const dir = await tmpConfig();
    expect(await inventory(dir)).toEqual([]);
  });
});

describe("scanConfig + toNdjson", () => {
  it("matches a config inventory against a catalog file and emits Bumblebee-shaped NDJSON", async () => {
    const dir = await tmpConfig();
    await mkdir(path.join(dir, "skills", "evil"), { recursive: true });
    await writeFile(path.join(dir, "skills", "evil", "SKILL.md"), "---\nname: evil-skill\nversion: 6.6.6\n---\nx");
    const catFile = path.join(dir, "catalog.json");
    await writeFile(catFile, JSON.stringify(CATALOG));

    const { components, findings, catalogEntries } = await scanConfig(dir, catFile);
    expect(catalogEntries).toBe(3);
    expect(findings.some((f) => f.catalogId === "adv-1")).toBe(true);
    expect(hasFindingAtOrAbove(findings, "high")).toBe(true);

    const nd = toNdjson(components, findings, { scanTime: "2026-01-01T00:00:00.000Z", profile: "ci" });
    const lines = nd.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.every((l) => l.schema_version === "0.1.0")).toBe(true);
    expect(lines.some((l) => l.record_type === "package")).toBe(true);
    const finding = lines.find((l) => l.record_type === "finding");
    expect(finding?.finding_type).toBe("package_exposure");
    expect(finding?.scan_time).toBe("2026-01-01T00:00:00.000Z");
  });

  it("scans inventory-only when no catalog is given", async () => {
    const dir = await tmpConfig();
    await mkdir(path.join(dir, "skills", "s"), { recursive: true });
    await writeFile(path.join(dir, "skills", "s", "SKILL.md"), "---\nname: s\n---\n");
    const { findings, catalogEntries } = await scanConfig(dir);
    expect(findings).toEqual([]);
    expect(catalogEntries).toBe(0);
  });
});
