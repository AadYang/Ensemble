// The three rules a spawned subagent lives under.
//
//  1. PERMISSIONS ARE INHERITED. A subagent is the same work continuing one
//     level down, so "the parent did not have to ask for this" must stay true
//     for the child. A child that reset to `default` stopped every delegated
//     write on an approval popup its parent would never have shown.
//  2. IT IS PRIVATE TO ITS SPAWNER. Another agent may not hand work to it
//     (peer_send's continue/review/fork are task handoffs), and a subagent has
//     exactly ONE link, pointing up: it may contact the agent that spawned it
//     and nothing else — not other agents, not siblings, and not subagents of
//     its own. Refusals name the parent as the right recipient.
//  3. IT IS ARCHIVED WHEN ITS TASK ENDS. One task, then deactivated — the child
//     must not stay a live, re-runnable, messageable agent in the sidebar
//     forever. Nothing is deleted: transcript, artifacts and summary stay.

import { describe, it, expect, beforeAll } from "vitest";
import type { AgentRuntime } from "../runtimes/types.js";

// In-memory DB so the test never touches the user's real ~/.ensemble.
process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;
let agentRowToSummary: typeof import("../SessionManager.js").agentRowToSummary;

type Broadcast = Record<string, unknown>;

class StubHub {
  broadcasts: Broadcast[] = [];
  sessionMessages: Array<{ sessionId: string; msg: Broadcast }> = [];
  size(): number { return 0; }
  add(): void {}
  remove(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  replayPendingFor(): void {}
  sendTo(): void {}
  sendToSession(sessionId: string, msg: Broadcast): void {
    this.sessionMessages.push({ sessionId, msg });
  }
  broadcast(msg: Broadcast): void {
    this.broadcasts.push(msg);
  }
}

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager, agentRowToSummary } = await import("../SessionManager.js"));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(check: () => Promise<boolean>, label: string, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A runtime that finishes every turn immediately, with output naming the
 *  prompt so a delivery can be traced to the agent that received it. */
function okRuntime(): AgentRuntime {
  return {
    async *query(opts) {
      yield { type: "sdk_message", payload: { type: "system", subtype: "init", session_id: opts.sessionId, model: opts.model } };
      yield {
        type: "sdk_message",
        payload: {
          type: "assistant",
          session_id: opts.sessionId,
          message: { content: [{ type: "text", text: `ran for ${opts.prompt}` }] },
        },
      };
      yield { type: "sdk_message", payload: { type: "result", subtype: "success", session_id: opts.sessionId } };
    },
  };
}

async function makeAgent(name: string, metadata: Record<string, unknown> = {}) {
  const provider = await prisma.provider.create({
    data: {
      name: `${name}-provider`,
      kind: "openai-compat",
      baseUrl: "https://api.example.test",
      apiKey: "k",
      models: ["m"],
    },
  });
  return prisma.agent.create({ data: { name, providerId: provider.id, model: "m", metadata } });
}

const manager = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new SessionManager(new StubHub() as any, () => okRuntime());

const agentOf = (id: string) => prisma.agent.findUnique({ where: { id } });
const metaOf = async (id: string) =>
  ((await agentOf(id))?.metadata ?? {}) as Record<string, unknown>;

const messagesOf = (agentId: string) => prisma.message.findMany({ where: { agentId } });
const queuedFor = (agentId: string) => prisma.pendingTurn.findMany({ where: { agentId } });

/** A subagent row exactly as `spawnTaskSubagent` writes one, without running
 *  anything: these tests are about the RULES, not about the spawn mechanics. */
async function makeSubagent(parentId: string, name: string, over: Record<string, unknown> = {}) {
  const parent = await agentOf(parentId);
  return prisma.agent.create({
    data: {
      name,
      parentId,
      teamId: parent?.teamId ?? null,
      providerId: parent?.providerId ?? null,
      model: parent?.model ?? "m",
      metadata: { taskDepth: 1, spawnedAsTaskFor: parentId, ...over },
    },
  });
}

describe("1. a subagent inherits its parent's permissions", () => {
  it("carries the parent's mode and sandbox instead of resetting to default", async () => {
    const parent = await makeAgent("perm-parent", {
      permissionMode: "bypassPermissions",
      sandboxMode: "danger-full-access",
    });
    const sessions = manager();

    const res = await sessions.spawnTaskSubagent(parent.id, "write it", "do the work");
    const child = await agentOf(res.subagentId);
    const summary = agentRowToSummary(child!);

    // The two settings a write tool actually gates on, read through the same
    // accessor the runtime uses.
    expect(summary.permissionMode).toBe("bypassPermissions");
    expect(summary.sandboxMode).toBe("danger-full-access");
    // Still a subagent, still nested, still depth-counted.
    expect(summary.parentId).toBe(parent.id);
    expect(summary.subagentKind).toBe("task");
    expect((child!.metadata as Record<string, unknown>).taskDepth).toBe(1);
  });

  it("inherits a non-default mode that still gates (acceptEdits)", async () => {
    const parent = await makeAgent("perm-parent-2", { permissionMode: "acceptEdits" });
    const sessions = manager();
    const res = await sessions.spawnTaskSubagent(parent.id, "edit it", "edit the file");
    const child = await agentOf(res.subagentId);
    expect(agentRowToSummary(child!).permissionMode).toBe("acceptEdits");
    // No sandbox override on the parent → none on the child either: an absent
    // key means "no override", and inventing one would be a stored choice the
    // user never made.
    expect(agentRowToSummary(child!).sandboxMode).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(child!.metadata, "sandboxMode")).toBe(false);
  });

  it("still defaults when the parent is on the default mode", async () => {
    const parent = await makeAgent("perm-parent-3");
    const sessions = manager();
    const res = await sessions.spawnTaskSubagent(parent.id, "plain", "nothing special");
    const child = await agentOf(res.subagentId);
    expect(agentRowToSummary(child!).permissionMode).toBe("default");
  });
});

describe("2. a subagent is private to the agent that spawned it", () => {
  it("refuses work sent by another agent, and names the parent instead", async () => {
    const parent = await makeAgent("private-parent");
    const other = await makeAgent("unrelated-agent");
    const child = await makeSubagent(parent.id, "task:audit");
    const sessions = manager();

    for (const mode of ["continue", "review", "fork", "raw"] as const) {
      const res = await sessions.sendPeerMessage(other.id, child.id, "please do this", mode);
      // Refused in every mode: `continue` is a handoff, but even `raw` is
      // another agent addressing someone else's worker.
      expect(res.startsWith("error:")).toBe(true);
      expect(res).toContain("subagent of");
      expect(res).toContain(parent.name);
    }

    // The interrupt path is a delivery path too — and it cannot be used to get
    // around the rule.
    const interrupted = await sessions.sendPeerMessage(other.id, child.id, "urgent", "raw", {
      interrupt: true,
      interruptReason: "would be stale by the time it is delivered",
    });
    expect(interrupted.startsWith("error:")).toBe(true);

    // Nothing was delivered, queued or run on the child.
    expect(await queuedFor(child.id)).toHaveLength(0);
    expect(await messagesOf(child.id)).toHaveLength(0);
    const stillLive = await agentOf(child.id);
    expect(stillLive!.status).not.toBe("RUNNING");
  });

  it("refuses another agent's peer_query too", async () => {
    const parent = await makeAgent("private-parent-2");
    const other = await makeAgent("unrelated-agent-2");
    const child = await makeSubagent(parent.id, "task:read");
    const sessions = manager();

    const res = await sessions.fetchPeerHistory(other.id, child.id, 5);
    expect(res.startsWith("error:")).toBe(true);
    expect(res).toContain("subagent");
  });

  it("lets the parent through — it is the one the child answers to", async () => {
    const parent = await makeAgent("owning-parent");
    const child = await makeSubagent(parent.id, "task:own");
    const sessions = manager();

    const res = await sessions.sendPeerMessage(parent.id, child.id, "carry on", "raw");
    expect(res.startsWith("error:")).toBe(false);
    expect(res).toContain(child.name);
    // …and the child can read its parent back.
    const parentHistory = await sessions.fetchPeerHistory(child.id, parent.id, 5);
    expect(parentHistory.startsWith("error:")).toBe(false);
  });

  it("stops a subagent reaching past its own parent — in EVERY direction", async () => {
    const parent = await makeAgent("reach-parent");
    const stranger = await makeAgent("stranger-agent");
    const child = await makeSubagent(parent.id, "task:reach");
    const sessions = manager();

    // Sideways: an unrelated agent.
    const sideways = await sessions.sendPeerMessage(child.id, stranger.id, "hello stranger", "raw");
    expect(sideways.startsWith("error:")).toBe(true);
    expect(sideways).toContain("subagent");
    expect(await queuedFor(stranger.id)).toHaveLength(0);

    // Sideways: a sibling (same parent) is not its parent either.
    const sibling = await makeSubagent(parent.id, "task:sibling");
    const toSibling = await sessions.sendPeerMessage(child.id, sibling.id, "sync up", "raw");
    expect(toSibling.startsWith("error:")).toBe(true);
    expect(await queuedFor(sibling.id)).toHaveLength(0);

    // Downward: not even a subagent of its OWN. There is one link and it points
    // up; a nested task's result travels back through the completion notice,
    // not through a peer channel the parent cannot see.
    const grandchild = await makeSubagent(child.id, "task:grandchild");
    const downward = await sessions.sendPeerMessage(child.id, grandchild.id, "start", "raw");
    expect(downward.startsWith("error:")).toBe(true);
    expect(downward).toContain("parent");
    expect(await queuedFor(grandchild.id)).toHaveLength(0);

    // …and the same holds for the read-only path, and for interrupt.
    expect((await sessions.fetchPeerHistory(child.id, grandchild.id, 5)).startsWith("error:")).toBe(true);
    const interrupted = await sessions.sendPeerMessage(child.id, stranger.id, "urgent", "raw", {
      interrupt: true,
      interruptReason: "would be stale by the time it is delivered",
    });
    expect(interrupted.startsWith("error:")).toBe(true);

    // The one link that DOES work: its own parent, and only its own parent.
    expect((await sessions.sendPeerMessage(child.id, parent.id, "reporting back", "raw")).startsWith("error:")).toBe(false);

    // Upward, the parent reaches its OWN direct task subagents — and stops
    // there. Its child's child is that child's worker, not the parent's.
    const toGrandchild = await sessions.sendPeerMessage(parent.id, grandchild.id, "jump in", "raw");
    expect(toGrandchild.startsWith("error:")).toBe(true);
    expect(await queuedFor(grandchild.id)).toHaveLength(0);
  });

  it("leaves ordinary agents (including user-created children) alone", async () => {
    const a = await makeAgent("normal-a");
    const b = await makeAgent("normal-b");
    // A user-created child: the user decided to nest it, so it is not private
    // to anyone — only an agent-SPAWNED subagent carries the rule.
    const userChild = await prisma.agent.create({
      data: { name: "user-child", parentId: a.id, providerId: a.providerId, model: "m" },
    });
    const sessions = manager();

    expect((await sessions.sendPeerMessage(a.id, b.id, "hi", "raw")).startsWith("error:")).toBe(false);
    expect((await sessions.sendPeerMessage(b.id, userChild.id, "hi", "raw")).startsWith("error:")).toBe(false);
  });
});

describe("3. a subagent is archived and deactivated when its task ends", () => {
  it("retires a BLOCKING subagent as soon as it answers", async () => {
    const parent = await makeAgent("archive-parent");
    const sessions = manager();

    const res = await sessions.spawnTaskSubagent(parent.id, "audit diff", "review it");
    const child = await agentOf(res.subagentId);

    // The whole point: by the time the parent's tool call returns, the child is
    // no longer a live agent.
    expect(agentRowToSummary(child!).closed).toBe(true);
    expect((child!.metadata as Record<string, unknown>).archivedAt).toBeTypeOf("string");
    expect((child!.metadata as Record<string, unknown>).archivedReason).toBe("task-completed");
    // Archived, NOT deleted: the answer the parent just received is still in
    // the child's own transcript, and the row is still there to read it from.
    expect(await messagesOf(res.subagentId)).not.toHaveLength(0);
    expect(res.finalText).toContain("ran for");
  });

  it("retires a DETACHED subagent when it reports terminal, and still notifies the parent", async () => {
    const parent = await makeAgent("archive-parent-bg");
    const sessions = manager();

    const res = await sessions.spawnTaskSubagent(parent.id, "bg audit", "long job", { background: true });
    await waitUntil(async () => {
      const row = await agentOf(res.subagentId);
      return (row?.metadata as Record<string, unknown> | undefined)?.archivedAt !== undefined;
    }, "child archived");

    const child = await agentOf(res.subagentId);
    expect(agentRowToSummary(child!).closed).toBe(true);
    expect((child!.metadata as Record<string, unknown>).archivedReason).toBe("task-completed");
    // The child being archived does not cost the parent its notification.
    await waitUntil(async () => {
      const rows = await messagesOf(parent.id);
      return rows.some((m) => (m.payload as Record<string, unknown>).subtype === "background_subagent_finished");
    }, "parent finished-record");
  });

  it("deactivates it for real: a retired child cannot be run again", async () => {
    const parent = await makeAgent("archive-parent-2");
    const sessions = manager();
    const res = await sessions.spawnTaskSubagent(parent.id, "once", "do it once");

    const before = await messagesOf(res.subagentId);
    await sessions.sendMessage(res.subagentId, "do it again");
    // Refused at the same gate every closed agent hits — no new turn ran.
    expect(await messagesOf(res.subagentId)).toHaveLength(before.length);
  });

  it("is idempotent, and never closes an agent the user owns", async () => {
    const parent = await makeAgent("archive-parent-3");
    const sessions = manager();
    const res = await sessions.spawnTaskSubagent(parent.id, "twice", "do it");
    const first = await metaOf(res.subagentId);

    await sessions.retireSubagent(res.subagentId);
    const second = await metaOf(res.subagentId);
    // A second retirement does not restamp the archive time.
    expect(second.archivedAt).toBe(first.archivedAt);

    // A top-level agent, and a user-created nested one, are the user's to close.
    const plain = await makeAgent("archive-parent-top");
    await sessions.retireSubagent(plain.id);
    expect(agentRowToSummary((await agentOf(plain.id))!).closed).toBe(false);
    const userChild = await prisma.agent.create({
      data: { name: "user-child-keep", parentId: plain.id, providerId: plain.providerId, model: "m" },
    });
    await sessions.retireSubagent(userChild.id);
    expect(agentRowToSummary((await agentOf(userChild.id))!).closed).toBe(false);
  });
});
