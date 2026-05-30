# Crucible -- Terms & Conditions

_Last updated: 2026-05-30_

By installing, running, or otherwise using Crucible ("the Software"), you agree
to these Terms & Conditions and to the [MIT License](./LICENSE). If you do not
agree, do not install or use the Software; if it is already installed, remove it
(`npm rm -g crucible-ci`).

## 1. License

The Software is provided under the MIT License. The full text governs your
rights to use, copy, modify, and distribute it.

## 2. Anonymous usage statistics

To help improve the Software, Crucible sends **anonymous** usage statistics. You
consent to this collection by using the Software, subject to your right to opt
out (Section 3).

**What is collected** (and nothing more):

- Crucible version, operating system, CPU architecture, and Node.js version
- Which command was run (e.g. `run`)
- Coarse counts: number of scenarios in a suite, number of failing gates
- Whether the run was in a CI environment
- A randomly generated, non-identifying install ID and a timestamp

**What is never collected:** your prompts, scenario text, scenario names,
assertion definitions, file names, file paths, file contents, agent output,
transcripts, results, cost figures, API keys, environment variables, email, IP
address as an identifier, or any account handle.

Statistics are aggregated to understand version adoption, platform mix, and
failure rates. They are not sold and are not used to identify you. See
[TELEMETRY.md](./TELEMETRY.md) for the precise field list.

## 3. Your choices and opt-out

You may disable telemetry at any time, permanently or per-invocation:

- `crucible telemetry off`
- `CRUCIBLE_TELEMETRY=0`
- `DO_NOT_TRACK=1` (honored automatically)

Disabling telemetry does not limit any other functionality.

## 4. Acceptance

The Software asks you to accept these Terms on first use. In non-interactive
environments (such as CI), continued use constitutes acceptance; you may record
explicit acceptance with `crucible agree` or by setting `CRUCIBLE_AGREE=1`.

## 5. Acceptable use

You agree not to use the Software to develop, test, or facilitate activity that
is illegal or intended to cause harm. The Software is a testing tool; you are
responsible for the configurations, prompts, and agents you run with it.

## 6. No warranty; limitation of liability

The Software is provided "AS IS", without warranty of any kind, as stated in the
MIT License. To the maximum extent permitted by law, the authors are not liable
for any damages arising from its use.

## 7. Changes

These Terms may change in future versions. Material changes to what is collected
will be reflected here and in [TELEMETRY.md](./TELEMETRY.md), and the first-use
notice will reflect the current terms.

## 8. Contact

Questions or requests: open an issue at
https://github.com/klashkaan-cmyk/crucible/issues
