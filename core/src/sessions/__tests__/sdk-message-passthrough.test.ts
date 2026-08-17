// Guards SessionManager's sdk_message adapter loop against the message-type
// churn that lands with claude-agent-sdk upgrades. The 0.3.x SDK widened the
// SDKMessage union with many new variants (rate_limit_event, tool_progress,
// system/thinking_tokens, …). SessionManager must never crash on a type it
// doesn't special-case: unknown top-level types are passed through (persisted +
// broadcast) and the reserved internal system/thinking_tokens message is
// silently ignored — either way the turn still completes at `result`.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime, RuntimeOptions } from "../runtimes/types.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

vi.mock("../../cli-config.js", () => ({
  getClaudeCliPath: vi.fn(async () => "mock-claude"),
  getCodexCliPath: vi.fn(async () => "mock-codex"),
  CLI_INSTALL_INFO: {
    claude: { recommendedInstallCommand: "install claude" },
    codex: { recommendedInstallCommand: "install codex", loginCommand: "codex login" },
  },
}));

class StubHub {
  events: Array<{ kind: "session" | "broadcast"; msg: Record<string, unknown> }> = [];
  sendToSession(_sessionId: string, msg: Record<string, unknown>): void {
    this.events.push({ kind: "session", msg });
  }
  broadcast(msg: Record<string, unknown>): void {
    this.events.push({ kind: "broadcast", msg });
  }
}

let prisma: typeof import("../../db.js").prisma;
let SessionManager: typeof import("../SessionManager.js").SessionManager;

beforeAll(async () => {
  ({ prisma } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionManager sdk_message passthrough", () => {
  it("passes through unknown SDK message types and ignores internal thinking_tokens without breaking the turn", async () => {
    const provider = await prisma.provider.create({
      data: { name: "passthrough-claude-provider", kind: "anthropic-local", models: ["claude-test"] },
    });
    const agent = await prisma.agent.create({
      data: { name: "passthrough-agent", providerId: provider.id, model: "claude-test" },
    });

    // Yields new/unknown 0.3.x message variants interleaved with the normal
    // assistant + result flow. None of these are special-cased by name in the
    // adapter loop except system/thinking_tokens (explicitly ignored).
    const runtime: AgentRuntime = {
      async *query(_opts: RuntimeOptions) {
        yield {
          type: "sdk_message" as const,
          payload: { type: "rate_limit_event", session_id: "sess-pt", status: "cooldown" } as never,
        };
        yield {
          type: "sdk_message" as const,
          payload: { type: "tool_progress", session_id: "sess-pt", toolUseID: "t1" } as never,
        };
        yield {
          type: "sdk_message" as const,
          payload: { type: "system", subtype: "thinking_tokens", session_id: "sess-pt" } as never,
        };
        yield {
          type: "sdk_message" as const,
          payload: {
            type: "assistant",
            session_id: "sess-pt",
            message: { content: [{ type: "text", text: "done" }] },
          } as never,
        };
        yield {
          type: "sdk_message" as const,
          payload: { type: "result", subtype: "success", session_id: "sess-pt", modelUsage: {} } as never,
        };
      },
    };

    const hub = new StubHub();
    const sessions = new SessionManager(hub as never, () => runtime);

    // Must not throw on any of the unfamiliar message types.
    const result = await sessions.sendMessage(agent.id, "trigger churny message stream");
    expect(result?.finalText).toBe("done");

    // Turn completed normally — not an error state.
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(after?.status).not.toBe("ERROR");

    // Unknown top-level types are persisted (passthrough); thinking_tokens is not.
    const persistedTypes = (
      await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } })
    ).map((r) => r.type);
    expect(persistedTypes).toContain("rate_limit_event");
    expect(persistedTypes).toContain("tool_progress");
    expect(persistedTypes).toContain("assistant");
    expect(persistedTypes).toContain("result");
    expect(persistedTypes).not.toContain("system");

    // Unknown types are also broadcast to the session; thinking_tokens is filtered.
    const broadcastMsgTypes = hub.events
      .filter((e) => e.kind === "session" && e.msg.type === "message")
      .map((e) => (e.msg.msg as { type?: string })?.type);
    expect(broadcastMsgTypes).toContain("rate_limit_event");
    expect(broadcastMsgTypes).toContain("tool_progress");
    expect(broadcastMsgTypes).not.toContain("system");
  });
});
