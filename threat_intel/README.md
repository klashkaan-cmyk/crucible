# threat_intel — exposure catalogs

Catalogs of known-compromised components that `crucible scan` and the
`no_known_exposure` assertion match a config against. Drop one or more `*.json`
files here; Crucible merges every catalog in this directory (they must share a
`schema_version`). `crucible lint` and `crucible scan` auto-discover a
`threat_intel/` directory sitting next to the config under test.

```bash
crucible scan --config .claude --exposure-catalog threat_intel/
crucible lint --config .claude            # auto-discovers ./threat_intel
```

## Catalog format

Bumblebee-compatible. One object with `schema_version` and an `entries` array:

```json
{
  "schema_version": "0.1.0",
  "entries": [
    {
      "id": "GHSA-xxxx-xxxx-xxxx",
      "name": "human-readable advisory label",
      "ecosystem": "npm",
      "package": "the-package-identifier",
      "versions": ["1.2.3", "1.2.4"],
      "severity": "critical"
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `id` | advisory identifier (GHSA / CVE / OSV / your own) |
| `name` | human label shown in findings |
| `ecosystem` | one of `npm`, `agent-skill`, `mcp` (matched against what Crucible inventories) |
| `package` | the exact identifier to match (npm package, skill `name`, or MCP server key) |
| `versions` | optional; exact versions that are bad. **Omit to flag every version.** |
| `severity` | `critical` \| `high` \| `medium` \| `low` \| `info` (drives the `--fail-on` / `min_severity` gate) |

Matching is exact on `(ecosystem, package, version)`. MCP servers launched via
`npx -y pkg@1.2.3` also yield an `npm` component for the underlying package, so
an `npm` advisory catches a compromised MCP server by its package.

## Where to get real data

The example file here is **illustrative only** (fake package names that match
nothing). Populate from authoritative feeds:

- **GitHub Advisory Database** / **OSV.dev** — npm, etc.; export to this schema.
- **npm audit** — for your own dependency tree.
- **Bumblebee** (https://github.com/perplexityai/bumblebee, Apache-2.0) — maintains
  exposure catalogs under its own `threat_intel/` and an `osvcatalog` tool. Because
  Crucible's catalog schema is compatible, you can point `--exposure-catalog`
  straight at a Bumblebee-published catalog.

Keep catalogs in version control so a regression run flags the moment a config
starts pulling a freshly-disclosed bad component.
