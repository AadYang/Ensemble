import type { LoopTask, LoopView } from "@agentorch/shared";

export interface LoopStartBody {
  goal: string;
  verifier?: { kind: "command" | "job" | "file-marker" | "peer-review"; spec: string } | null;
  doneWhen?: { kind: "exit-0" | "file-contains" | "peer-lgtm"; spec: string };
  maxIterations?: number;
  session?: "resume" | "fresh-disk";
  snapshot?: "git-commit" | "none";
  permissionBump?: "acceptEdits" | "bypassPermissions" | null;
  reviewerAgentId?: string;
  worktree?: boolean;
  recipe?: "tdd" | "ralph" | "pr-gate";
  teamId?: string;
}

export interface LoopSuggest {
  verifier: LoopStartBody["verifier"] | null;
  source: string | null;
  testCommands: string[];
}

async function throwIfBad(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
  throw new Error(body?.message || body?.error || `${fallback}: ${res.status}`);
}

export async function listLoops(): Promise<LoopView[]> {
  const res = await fetch("/api/loops");
  if (!res.ok) return [];
  return (await res.json()) as LoopView[];
}

export async function suggestLoop(agentId: string): Promise<LoopSuggest> {
  const res = await fetch(`/api/agents/${agentId}/loop/suggest`);
  if (!res.ok) return { verifier: null, source: null, testCommands: [] };
  return (await res.json()) as LoopSuggest;
}

export async function startLoop(agentId: string, body: LoopStartBody): Promise<LoopView> {
  const res = await fetch(`/api/agents/${agentId}/loop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await throwIfBad(res, "startLoop");
  return (await res.json()) as LoopView;
}

export async function startTeamLoop(teamId: string, body: LoopStartBody): Promise<LoopView[]> {
  const res = await fetch(`/api/teams/${teamId}/loop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await throwIfBad(res, "startTeamLoop");
  return (await res.json()) as LoopView[];
}

export async function loopAction(agentId: string, action: "stop" | "pause" | "resume" | "verify"): Promise<LoopView> {
  const res = await fetch(`/api/agents/${agentId}/loop/${action}`, { method: "POST" });
  await throwIfBad(res, `loop ${action}`);
  return (await res.json()) as LoopView;
}

export async function patchLoop(
  agentId: string,
  body: { doneWhen?: LoopStartBody["doneWhen"]; maxIterations?: number },
): Promise<LoopView> {
  const res = await fetch(`/api/agents/${agentId}/loop`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await throwIfBad(res, "patchLoop");
  return (await res.json()) as LoopView;
}

export async function putLoopTasks(agentId: string, tasks: LoopTask[]): Promise<LoopView> {
  const res = await fetch(`/api/agents/${agentId}/loop/tasks`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks }),
  });
  await throwIfBad(res, "putLoopTasks");
  return (await res.json()) as LoopView;
}
