import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopVerifier } from "@agentorch/shared";

export interface LoopPrefill {
  verifier: LoopVerifier | null;
  source: string | null;
  testCommands: string[];
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function commandsFromPackageJson(root: string): string[] {
  const raw = readText(join(root, "package.json"));
  if (!raw) return [];
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const out: string[] = [];
    for (const name of ["test", "check", "lint", "typecheck"]) {
      if (typeof scripts[name] === "string") out.push(`npm run ${name}`);
    }
    return out;
  } catch {
    return [];
  }
}

function verifierFromAgentsMd(root: string): LoopVerifier | null {
  const text = readText(join(root, "AGENTS.md")) ?? readText(join(root, "CLAUDE.md"));
  if (!text) return null;
  const done = /完成条件[\s\S]{0,400}?`([^`]+)`/.exec(text) ?? /Completion[^\n]*\n[-*]\s+`([^`]+)`/i.exec(text);
  if (done?.[1]) return { kind: "command", spec: done[1].trim() };
  const marker = /## DONE|ALL_COMPLETE/.test(text);
  if (marker) return { kind: "file-marker", spec: "## DONE" };
  return null;
}

function verifierFromClaudeHook(root: string): LoopVerifier | null {
  const hook = join(root, ".claude", "hooks", "verify.sh");
  if (existsSync(hook)) return { kind: "command", spec: hook };
  const settings = readText(join(root, ".claude", "settings.json"));
  if (!settings) return null;
  try {
    const json = JSON.parse(settings) as { hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> } };
    const cmd = json.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    if (typeof cmd === "string" && cmd.trim()) return { kind: "command", spec: cmd.trim() };
  } catch {
    return null;
  }
  return null;
}

/** Read-only project hints for the Loop dialog. Never loads settingSources. */
export function prefillLoopFromProject(projectRoot: string | null): LoopPrefill {
  if (!projectRoot) return { verifier: null, source: null, testCommands: [] };
  const testCommands = commandsFromPackageJson(projectRoot);
  const fromHook = verifierFromClaudeHook(projectRoot);
  if (fromHook) return { verifier: fromHook, source: "project-hook", testCommands };
  const fromAgents = verifierFromAgentsMd(projectRoot);
  if (fromAgents) return { verifier: fromAgents, source: "agents-md", testCommands };
  if (testCommands[0]) return { verifier: { kind: "command", spec: testCommands[0] }, source: "package.json", testCommands };
  return { verifier: null, source: null, testCommands };
}
