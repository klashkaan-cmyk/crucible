/**
 * Hook injection. To capture *what actually fired* during a headless run
 * (which tools, which subagents), Crucible writes a temporary settings file
 * that registers PostToolUse + SubagentStop hooks. Each hook is a tiny shell
 * command that appends a JSON line to a per-trial capture log. The agent under
 * test is otherwise untouched.
 *
 * The capture log is then parsed back into `Invocation[]`.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Invocation } from "./types.js";

/**
 * Build a settings.json fragment that tees tool + subagent events into
 * `logPath`. `jq` is avoided; we use a portable node one-liner so the only
 * runtime dependency is node itself (already present wherever Claude Code runs).
 */
export function buildCaptureSettings(logPath: string): unknown {
  const append = (type: string) =>
    `node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{` +
    `try{const j=JSON.parse(d);` +
    `const name=${type === "tool" ? "j.tool_name" : 'j.subagent_type||j.agent_type||"subagent"'};` +
    `require("fs").appendFileSync(process.env.CRUCIBLE_LOG,JSON.stringify({type:"${type}",name})+"\\n");` +
    `}catch(e){}})'`;

  return {
    hooks: {
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: append("tool") }] },
      ],
      SubagentStop: [
        { hooks: [{ type: "command", command: append("subagent") }] },
      ],
    },
  };
}

export async function writeCaptureSettings(
  settingsPath: string,
  logPath: string,
): Promise<void> {
  await writeFile(settingsPath, JSON.stringify(buildCaptureSettings(logPath), null, 2));
}

export async function readInvocations(logPath: string): Promise<Invocation[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const out: Invocation[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Invocation;
      if (obj && (obj.type === "tool" || obj.type === "subagent") && obj.name) {
        out.push({ type: obj.type, name: obj.name });
      }
    } catch {
      // skip malformed capture lines
    }
  }
  return out;
}

export function captureLogPath(workdir: string): string {
  return path.join(workdir, ".crucible-capture.jsonl");
}
