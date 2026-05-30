/**
 * Render a transcript diff for humans: a colored terminal view and a
 * self-contained HTML page (no external assets, no JS required). The HTML is
 * the "why did it change?" viewer -- two runs side by side with added/removed
 * steps highlighted and the final messages shown in full.
 */

import pc from "picocolors";
import {
  stepLabel,
  summarizeDiff,
  type DiffRow,
  type Transcript,
} from "./transcript.js";

export function renderTerminal(a: Transcript, b: Transcript, rows: ReadonlyArray<DiffRow>): string {
  const s = summarizeDiff(a, b, rows);
  const lines: string[] = [];
  lines.push(pc.bold(`Transcript diff: ${a.scenario}`));
  lines.push(
    pc.dim(
      `A: trial ${a.trial}  ${a.steps.length} steps  ${a.numTurns} turns  $${a.costUsd.toFixed(4)}\n` +
        `B: trial ${b.trial}  ${b.steps.length} steps  ${b.numTurns} turns  $${b.costUsd.toFixed(4)}`,
    ),
  );
  lines.push(
    `${pc.green(`+${s.added}`)} ${pc.red(`-${s.removed}`)} ${pc.dim(`=${s.unchanged}`)}` +
      `  ${delta("turns", s.turnDelta)}  ${delta("cost $", s.costDelta, 4)}`,
  );
  lines.push("");
  for (const row of rows) {
    if (row.marker === "same") lines.push(pc.dim(`   ${stepLabel(row.a!)}`));
    else if (row.marker === "del") lines.push(pc.red(` - ${stepLabel(row.a!)}`));
    else lines.push(pc.green(` + ${stepLabel(row.b!)}`));
  }
  if (a.finalResult !== b.finalResult) {
    lines.push("");
    lines.push(pc.yellow("final message differs (see --html for full text)"));
  }
  return lines.join("\n");
}

function delta(label: string, value: number, digits = 0): string {
  if (value === 0) return pc.dim(`${label} =`);
  const txt = `${label} ${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
  return value > 0 ? pc.red(txt) : pc.green(txt);
}

export function renderHtml(a: Transcript, b: Transcript, rows: ReadonlyArray<DiffRow>): string {
  const s = summarizeDiff(a, b, rows);
  const stepRows = rows
    .map((r) => {
      const cls = r.marker;
      const left = r.a ? esc(stepLabelHtml(r.a)) : "";
      const right = r.b ? esc(stepLabelHtml(r.b)) : "";
      return `<tr class="${cls}"><td class="l">${left}</td><td class="r">${right}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Crucible transcript diff: ${esc(a.scenario)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d1117; color: #c9d1d9; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 16px 24px; border-bottom: 1px solid #30363d; }
  h1 { margin: 0 0 8px; font-size: 16px; }
  .meta { color: #8b949e; font-size: 13px; }
  .stat { display: inline-block; margin-right: 16px; }
  .add { color: #3fb950; } .del { color: #f85149; } .same { color: #8b949e; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 24px; color: #8b949e; border-bottom: 1px solid #30363d; position: sticky; top: 0; background: #0d1117; }
  td { padding: 3px 24px; white-space: pre-wrap; vertical-align: top; width: 50%; border-bottom: 1px solid #161b22; }
  tr.add td.r { background: rgba(46,160,67,.15); }
  tr.del td.l { background: rgba(248,81,73,.15); }
  tr.add td.l, tr.del td.r { background: #0d1117; }
  .finals { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #30363d; }
  .finals section { background: #0d1117; padding: 12px 24px; }
  .finals h2 { font-size: 13px; color: #8b949e; margin: 0 0 8px; }
  pre { white-space: pre-wrap; margin: 0; color: #c9d1d9; }
</style></head>
<body>
<header>
  <h1>Transcript diff — ${esc(a.scenario)}</h1>
  <div class="meta">
    <span class="stat add">+${s.added} added</span>
    <span class="stat del">-${s.removed} removed</span>
    <span class="stat same">=${s.unchanged} unchanged</span>
    <span class="stat">turns ${a.numTurns} → ${b.numTurns}</span>
    <span class="stat">cost $${a.costUsd.toFixed(4)} → $${b.costUsd.toFixed(4)}</span>
  </div>
</header>
<table>
  <thead><tr><th>A · trial ${a.trial} (baseline)</th><th>B · trial ${b.trial} (current)</th></tr></thead>
  <tbody>
${stepRows}
  </tbody>
</table>
<div class="finals">
  <section><h2>A · final message</h2><pre>${esc(a.finalResult) || "<em>(empty)</em>"}</pre></section>
  <section><h2>B · final message</h2><pre>${esc(b.finalResult) || "<em>(empty)</em>"}</pre></section>
</div>
</body></html>
`;
}

function stepLabelHtml(s: { type: "tool" | "subagent"; name: string; summary?: string }): string {
  return stepLabel(s);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
