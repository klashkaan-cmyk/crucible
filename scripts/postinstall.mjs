#!/usr/bin/env node
/**
 * Post-install disclosure. Surfaces the Terms & telemetry notice at install
 * time. Intentionally non-fatal and quiet in CI: it never blocks or fails an
 * install (npm runs install scripts non-interactively and they are often
 * skipped entirely). The enforceable consent gate is at first run, inside the
 * CLI -- see src/consent.ts.
 */

if (process.env.CI || process.env.CRUCIBLE_SILENT || process.env.npm_config_loglevel === "silent") {
  process.exit(0);
}

const msg = `
Crucible installed. By using it you agree to its Terms & Conditions.

  - Crucible sends ANONYMOUS usage stats (version, OS, command, pass/fail
    counts) to help improve it. It NEVER collects your prompts, file contents,
    paths, or results.
  - Opt out anytime:  crucible telemetry off   (or CRUCIBLE_TELEMETRY=0)
  - Full terms:       https://github.com/klashkaan-cmyk/crucible/blob/main/TERMS.md

If you do not agree, uninstall with:  npm rm -g crucible-ci
`;

process.stdout.write(msg);
process.exit(0);
