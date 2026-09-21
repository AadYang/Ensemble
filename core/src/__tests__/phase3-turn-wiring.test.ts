// The turn path, end to end: what the runtime is actually handed.
//
// The module tests prove the pieces; this file proves the WIRING — that the
// plan the runtime runs under carries the history and skill decision, that the
// numbers `/status` prints come from that same plan, and that the skill section
// is injected exactly ONCE whichever runtime strategy is in play.
//
// `chooseRuntime` is the only thing stubbed, and it records the RuntimeOptions
// it was given, so every assertion here is about the real object the SDK would
// have received.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeOptions } from "../sessions/runtimes/types.js";

process.env.AGENTORCH_DB_PATH = ":memory:";

const capturedRuntimeOptions: RuntimeOptions[] = [];
const mockCtl = { promptTooLong: false };
const MARKER = "PHASE3_SKILL_BODY_MARKER";

vi.mock("../sessions/runtimes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/runtimes/index.js")>()),
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions) {
      capturedRuntimeOptions.push(opts);
      if (mockCtl.promptTooLong) {
        yield {
          type: "sdk_message" as const,
          payload: {
            type: "result" as const,
            subtype: "success",
            is_error: true,
            result: "Prompt is too long",
            session_id: "too-long-session",
            modelUsage: {},
          },
        };
        return;
      }
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "result" as const,
          subtype: "success",
          session_id: `session-${capturedRuntimeOptions.length}`,
          modelUsage: {},
        },
      };
    },
  }),
}));

vi.mock("../cli-config.js", () => ({
  getClaudeCliPath: vi.fn(async () => "mock-claude"),
  getCodexCliPath: vi.fn(async () => "mock-codex"),
}));

let prisma: typeof import("../db.js").prisma;
let SessionManager: typeof import("../sessions/SessionManager.js").SessionManager;
let hashStableSystemPrompt: typeof import("../sessions/SessionManager.js").hashStableSystemPrompt;

class StubHub {
  events: Array<{ kind: "session" | "broadcast"; msg: Record<string, unknown> }> = [];
  sendToSession(_sessionId: string, msg: Record<string, unknown>): void {
    this.events.push({ kind: "session", msg });
  }
  broadcast(msg: Record<string, unknown>): void {
    this.events.push({ kind: "broadcast", msg });
  }
}

let projectRoot: string;

beforeAll(async () => {
  ({ prisma } = await import("../db.js"));
  ({ SessionManager, hashStableSystemPrompt } = await import("../sessions/SessionManager.js"));
});

beforeEach(() => {
  capturedRuntimeOptions.length = 0;
  mockCtl.promptTooLong = false;
  projectRoot = mkdtempSync(join(tmpdir(), "phase3-wiring-"));
  mkdirSync(join(projectRoot, ".agents", "skills", "reviewer"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".agents", "skills", "reviewer", "SKILL.md"),
    [
      "---",
      "name: reviewer",
      "description: Use when the user asks to review code for bugs",
      "---",
      "",
      `Body line one. ${MARKER}`,
      "Body line two.",
      "",
    ].join("\n"),
    "utf8",
  );
});

const cleanup = () => rmSync(projectRoot, { recursive: true, force: true });

async function makeAgent(opts: {
  kind: string;
  metadata?: Record<string, unknown>;
  model?: string;
}) {
  const provider = await prisma.provider.create({
    data: {
      name: `p-${Math.random().toString(36).slice(2)}`,
      kind: opts.kind,
      models: [opts.model ?? "test-model"],
      apiKey: opts.kind === "openai-local" ? "sk-test" : null,
      metadata: opts.kind === "openai-codex" ? { defaultSandbox: "danger-full-access" } : {},
    },
  });
  return prisma.agent.create({
    data: {
      name: `a-${Math.random().toString(36).slice(2)}`,
      providerId: provider.id,
      model: opts.model ?? "test-model",
      projectRoot,
      systemPrompt: "You are a test agent.",
      metadata: opts.metadata ?? {},
    },
  });
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("gate 12: the skill section is injected exactly once, never twice", () => {
  it("fresh session: in the system prompt, not in the prompt", async () => {
    const agent = await makeAgent({ kind: "anthropic-local" });
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "please review my code for bugs");

    expect(capturedRuntimeOptions).toHaveLength(1);
    const opts = capturedRuntimeOptions[0]!;
    const system = opts.systemPrompt ?? "";
    const combined = `${system}\n${opts.prompt}`;

    expect(combined).toContain(MARKER);
    expect(occurrences(combined, MARKER)).toBe(1);
    expect(system).toContain(MARKER);
    expect(opts.prompt).not.toContain(MARKER);
    // The project skill was discovered through the agent's project root, which
    // is what makes `.agents/skills` reachable at all.
    expect(opts.runPlan.skills.loadedSkills.map((s) => s.name)).toContain("reviewer");
    expect(opts.runPlan.skills.loadedSkills[0]!.source).toBe("project");
    cleanup();
  });

  it("resumed session: in the prompt (once), and NOT left in the system prompt", async () => {
    // A resumed CLI keeps the system prompt it was started with, so the skill
    // section has to travel in the prompt — and must not ALSO be in
    // systemPrompt, which is exactly how the same bodies used to be sent twice.
    const agent = await makeAgent({ kind: "anthropic-local" });
    const promptHash = hashStableSystemPrompt({
      permissionMode: "default",
      teamContext: "",
      baseSystemPrompt: agent.systemPrompt ?? "",
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          systemPromptHash: promptHash,
        },
      },
    });

    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "please review my code for bugs");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.resume).toBe("019ea530-56b8-7163-8b3c-5bd5ae5c2c79");
    const system = opts.systemPrompt ?? "";
    const combined = `${system}\n${opts.prompt}`;
    expect(combined).toContain(MARKER);
    expect(occurrences(combined, MARKER)).toBe(1);
    expect(opts.prompt).toContain(MARKER);
    expect(system).not.toContain(MARKER);
    cleanup();
  });
});

describe("gate 11: /status reads the same plan the runtime ran under", () => {
  it("reports the turn's skills and history from the plan, not a second resolution", async () => {
    const agent = await makeAgent({ kind: "anthropic-local" });
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "please review my code for bugs");

    const opts = capturedRuntimeOptions[0]!;
    const status = await sessions.getStatusReport(agent.id);

    // Same object, field for field: the plan the SDK was handed.
    expect(status?.skills.turn).toEqual(opts.runPlan.skills);
    expect(status?.history).toEqual(opts.runPlan.history);
    expect(status?.runPlanSource).toBe("last-turn");
    // enabled/disabled/auto come from the agent's own metadata, the same lists
    // `selectSkills` was given.
    expect(status?.skills.autoActivationEnabled).toBe(true);
    expect(status?.skills.blocked).toEqual([]);
    // The plan is attached exactly once per turn: history and skills are both
    // resolved structures, never the phase-1/2 placeholders.
    expect(opts.runPlan.history.status).toBe("resolved");
    expect(opts.runPlan.skills.status).toBe("resolved");
    cleanup();
  });

  it("reflects a disabled skill and an off auto-activation switch", async () => {
    const agent = await makeAgent({
      kind: "anthropic-local",
      metadata: { disabledSkills: ["reviewer"], skillsAutoActivation: false },
    });
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "please review my code for bugs");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.runPlan.skills.loadedSkills).toEqual([]);
    expect(opts.runPlan.skills.diagnostics.join("\n")).toContain("automatic skill activation is off");
    const status = await sessions.getStatusReport(agent.id);
    expect(status?.skills.blocked).toEqual(["reviewer"]);
    expect(status?.skills.autoActivationEnabled).toBe(false);
    cleanup();
  });
});

describe("gate 4: a long compact summary is handed over whole", () => {
  it("a 9000-character summary reaches the runtime unclipped, marker and all", async () => {
    const agent = await makeAgent({ kind: "anthropic-local" });
    // Past the retired 6 000-character clip, with a marker beyond it: if any
    // layer still re-truncated the summary, this is the text that would vanish.
    // Prose rather than one repeated character — a real summary reads like this,
    // and a 9 000-character run of a single byte is a pathological case for the
    // BPE encoder (2.4s) that would measure the tokenizer, not this contract.
    const summaryText = `HEAD ${Array.from(
      { length: 150 },
      (_, i) => `sentence ${i} records what was decided and why it was decided.`,
    ).join(" ")} TAIL`;
    expect(summaryText.length).toBeGreaterThan(8_000);
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 0,
        type: "system",
        payload: {
          type: "system",
          subtype: "compact",
          generation: 1,
          summaryVersion: 1,
          sourceHash: "hash-of-the-archived-range",
          messageRange: { fromSeq: 1, toSeq: 30, count: 30 },
          text: summaryText,
        },
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        seq: 1,
        type: "user",
        payload: { type: "user", message: { role: "user", content: "carry on" } },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "carry on");

    const opts = capturedRuntimeOptions[0]!;
    const carried = JSON.stringify(opts.history);
    expect(carried).toContain(summaryText);
    // The plan records the summary as the pinned, ranged thing it is — the
    // generation/range/hash travel with it, so a reader can go back to the
    // archive it came from.
    const summaryTurn = opts.runPlan.history.summaries[0]!;
    expect(summaryTurn.generation).toBe(1);
    expect(summaryTurn.count).toBe(30);
    expect(summaryTurn.sourceHash).toBe("hash-of-the-archived-range");
    expect(opts.runPlan.history.counts.summarized).toBe(30);
    cleanup();
  });
});

describe("gate 6 (wiring): the runtime's history matches the plan's decision", () => {
  it("local-rebuild hands the transcript it measured, and the plan says so", async () => {
    const agent = await makeAgent({ kind: "anthropic-local" });
    for (let i = 1; i <= 40; i++) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          seq: i,
          type: i % 2 === 0 ? "assistant" : "user",
          payload:
            i % 2 === 0
              ? { type: "assistant", message: { content: [{ type: "text", text: `answer ${i}` }] } }
              : { type: "user", message: { role: "user", content: `question ${i} ${"q".repeat(900)}` } },
        },
      });
    }
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "next question");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.runPlan.history.strategy).toBe("local-rebuild");
    // Nothing was trimmed on the way in: every prior turn reached the runtime.
    expect(opts.history.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(opts.history)).toContain("question 1");
    // The counts describe what was actually handed over.
    expect(opts.runPlan.history.counts.included).toBe(opts.history.length);
    expect(opts.runPlan.history.counts.dropped).toBe(0);
    expect(opts.runPlan.history.measuredTokens).toBeGreaterThan(0);
    cleanup();
  });

  it("runtime-session hands an EMPTY local history and names the owner in the plan", async () => {
    const agent = await makeAgent({ kind: "anthropic-local" });
    const promptHash = hashStableSystemPrompt({
      permissionMode: "default",
      teamContext: "",
      baseSystemPrompt: agent.systemPrompt ?? "",
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          systemPromptHash: promptHash,
        },
      },
    });
    for (let i = 1; i <= 12; i++) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          seq: i,
          type: i % 2 === 0 ? "assistant" : "user",
          payload:
            i % 2 === 0
              ? { type: "assistant", message: { content: [{ type: "text", text: `answer ${i}` }] } }
              : { type: "user", message: { role: "user", content: `question ${i}` } },
        },
      });
    }
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "continue");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.resume).toBe("019ea530-56b8-7163-8b3c-5bd5ae5c2c79");
    // The CLI holds the conversation. Sending a locally clipped copy of it would
    // be the pretence the strategy field exists to forbid.
    expect(opts.history).toEqual([]);
    expect(opts.runPlan.history.strategy).toBe("runtime-session");
    // The reason names the owner in words: "the CLI holds it" is the claim the
    // strategy field makes, and /status shows this sentence next to the strategy.
    expect(opts.runPlan.history.reason).toContain("holds the conversation");
    // ...but the plan still describes the SAME transcript, so `/status` and the
    // budget are not blanked out just because the runtime was not handed it.
    expect(opts.runPlan.history.counts.included).toBeGreaterThan(0);
    expect(opts.runPlan.history.measuredTokens).toBeGreaterThan(0);
    cleanup();
  });

  it("an invalidated resume reports why, and rebuilds locally", async () => {
    const agent = await makeAgent({ kind: "anthropic-local" });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        metadata: {
          lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
          // Deliberately stale: the assembled prompt has moved on since.
          systemPromptHash: "deadbeefdeadbeef",
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "continue");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.resume).toBeUndefined();
    expect(opts.runPlan.history.strategy).toBe("local-rebuild");
    // Not just "local-rebuild": the plan says the agent HAD a session and that
    // the assembled prompt moved on, which is the difference between "nothing to
    // resume" and "the resume was dropped".
    expect(opts.runPlan.history.reason).toContain("invalidated (systemPromptHash)");
    cleanup();
  });

  it("openai HTTP with a stored lastSessionId still rebuilds the transcript locally", async () => {
    const agent = await makeAgent({ kind: "openai-local", model: "deepseek-flash" });
    const promptHash = hashStableSystemPrompt({
      permissionMode: "default",
      teamContext: "",
      baseSystemPrompt: agent.systemPrompt ?? "",
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        metadata: {
          lastSessionId: "8cdf3d05-33a0-4f98-a3ca-15d4b6428481",
          systemPromptHash: promptHash,
        },
      },
    });
    for (let i = 1; i <= 6; i++) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          seq: i,
          type: i % 2 === 0 ? "assistant" : "user",
          payload:
            i % 2 === 0
              ? { type: "assistant", message: { content: [{ type: "text", text: `answer ${i}` }] } }
              : { type: "user", message: { role: "user", content: `question ${i}` } },
        },
      });
    }
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "what did I just ask?");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.runPlan.identity.runtime).toBe("openai");
    expect(opts.resume).toBeUndefined();
    expect(opts.runPlan.history.strategy).toBe("local-rebuild");
    expect(JSON.stringify(opts.history)).toContain("question 1");
    expect(opts.history.length).toBeGreaterThanOrEqual(6);
    cleanup();
  });

  it("anthropic-compat with a stored lastSessionId resumes the Claude CLI session", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: `p-${Math.random().toString(36).slice(2)}`,
        kind: "anthropic",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "sk-test",
        models: ["deepseek-flash"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: `a-${Math.random().toString(36).slice(2)}`,
        providerId: provider.id,
        model: "deepseek-flash",
        projectRoot,
        systemPrompt: "You are a test agent.",
      },
    });
    const promptHash = hashStableSystemPrompt({
      permissionMode: "default",
      teamContext: "",
      baseSystemPrompt: agent.systemPrompt ?? "",
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        metadata: {
          lastSessionId: "4044724a-cd87-4c3f-8c0f-e43afc9a16a4",
          systemPromptHash: promptHash,
        },
      },
    });
    for (let i = 1; i <= 6; i++) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          seq: i,
          type: i % 2 === 0 ? "assistant" : "user",
          payload:
            i % 2 === 0
              ? { type: "assistant", message: { content: [{ type: "text", text: `answer ${i}` }] } }
              : { type: "user", message: { role: "user", content: `question ${i}` } },
        },
      });
    }
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "what did I just ask?");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.runPlan.identity.runtime).toBe("claude");
    expect(opts.resume).toBe("4044724a-cd87-4c3f-8c0f-e43afc9a16a4");
    expect(opts.runPlan.history.strategy).toBe("runtime-session");
    expect(opts.history).toEqual([]);
    cleanup();
  });

  it("does not keep a Prompt-is-too-long CLI session as the next resume pointer", async () => {
    mockCtl.promptTooLong = true;
    const provider = await prisma.provider.create({
      data: {
        name: `p-${Math.random().toString(36).slice(2)}`,
        kind: "anthropic",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "sk-test",
        models: ["deepseek-flash"],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: `a-${Math.random().toString(36).slice(2)}`,
        providerId: provider.id,
        model: "deepseek-flash",
        projectRoot,
        systemPrompt: "You are a test agent.",
      },
    });
    const promptHash = hashStableSystemPrompt({
      permissionMode: "default",
      teamContext: "",
      baseSystemPrompt: agent.systemPrompt ?? "",
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: {
        metadata: {
          lastSessionId: "4044724a-cd87-4c3f-8c0f-e43afc9a16a4",
          systemPromptHash: promptHash,
        },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "continue");
    expect(capturedRuntimeOptions[0]?.resume).toBe("4044724a-cd87-4c3f-8c0f-e43afc9a16a4");
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    const meta = (after?.metadata && typeof after.metadata === "object" ? after.metadata : {}) as Record<
      string,
      unknown
    >;
    expect(meta.lastSessionId).toBeUndefined();
    cleanup();
  });

  it("codex gets the same history structure, with its version taken from the plan", async () => {
    const agent = await makeAgent({ kind: "openai-codex" });
    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "hello");

    const opts = capturedRuntimeOptions[0]!;
    expect(opts.runPlan.identity.runtime).toBe("codex");
    expect(opts.runPlan.history.status).toBe("resolved");
    expect(opts.runPlan.history.counts).toEqual({ included: 0, dropped: 0, summarized: 0 });
    expect(opts.runPlan.skills.status).toBe("resolved");
    // No continuation is claimed for a route that was never observed to support
    // one — server-conversation would be a lie about a request that carries the
    // transcript itself.
    expect(opts.runPlan.history.strategy).toBe("local-rebuild");
    cleanup();
  });
});

describe("the pre-dispatch compact runs on PRIOR rows, and the turn still completes", () => {
  /** Prose, not a repeated character: js-tiktoken takes ~2.4s on a long run of
   *  one byte and ~1ms on mixed text of the same size, so a fixture of repeated
   *  characters would measure the tokenizer, not this contract. */
  const lorem =
    "the quick brown fox jumps over the lazy dog while the reviewer reads the diff and writes it down ";

  it("archives only the rows before the current user message, then dispatches and persists", async () => {
    // A model with a small DOCUMENTED window (16 385 in, 4 096 out), so a real
    // overflow happens without a million-token fixture.
    const agent = await makeAgent({ kind: "openai-local", model: "gpt-3.5-turbo" });
    // ~150 000 characters (~35 000 tokens) of prior history against a 16 385-token
    // window: comfortably over, so the overflow is a fact and not a coincidence
    // of one tokenizer's rounding.
    const priorRows = 120;
    for (let i = 1; i <= priorRows; i++) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          seq: i,
          type: i % 2 === 0 ? "assistant" : "user",
          payload:
            i % 2 === 0
              ? {
                  type: "assistant",
                  message: { content: [{ type: "text", text: `answer ${i} ${lorem.repeat(12)}` }] },
                }
              : {
                  type: "user",
                  message: { role: "user", content: `question ${i} ${lorem.repeat(12)}` },
                },
        },
      });
    }

    const sessions = new SessionManager(new StubHub() as never);
    await sessions.sendMessage(agent.id, "please carry on");

    // The runtime was reached: an over-budget transcript is compacted first, not
    // refused, and the turn is not lost on the way.
    expect(capturedRuntimeOptions.length).toBeGreaterThan(0);
    const dispatched = capturedRuntimeOptions.at(-1)!;

    const rows = await prisma.message.findMany({ where: { agentId: agent.id }, orderBy: { seq: "asc" } });
    const userRows = rows.filter(
      (r) => r.type === "user" && (r.payload as { message?: { content?: unknown } }).message?.content === "please carry on",
    );
    // The request is still there, EXACTLY once, in its own row. It used to be
    // archived and deleted by the compact it triggered, leaving the turn with an
    // empty history.
    expect(userRows).toHaveLength(1);
    const userSeq = userRows[0]!.seq;
    expect(userSeq).toBe(priorRows + 1);

    const summaryRows = rows.filter(
      (r) => (r.payload as { subtype?: unknown }).subtype === "compact",
    );
    expect(summaryRows).toHaveLength(1);
    // The summary replaces the range it covers: at the end of the freed region,
    // BEFORE the current user turn (so the turn's own reread can see it) and
    // never at a seq a later runtime event wants.
    expect(summaryRows[0]!.seq).toBe(priorRows);
    expect(summaryRows[0]!.seq).toBeLessThan(userSeq);
    expect(rows.filter((r) => r.seq < userSeq).map((r) => r.seq)).toEqual([priorRows]);

    // The runtime's own output persisted AFTER the user row: the old
    // `lastSeq + 1` summary placement collided with exactly this insert.
    const resultRows = rows.filter((r) => r.type === "result");
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0]!.seq).toBe(userSeq + 1);

    // What the runtime was handed is the post-compact transcript, and the plan
    // says so: one summary and nothing dropped.
    expect(JSON.stringify(dispatched.history)).toContain("compact");
    expect(dispatched.runPlan.history.strategy).toBe("local-rebuild");
    expect(dispatched.runPlan.history.counts.dropped).toBe(0);
    expect(dispatched.runPlan.history.overBudget).toBe(false);
    expect(dispatched.prompt).toContain("please carry on");

    // Every original prior row is readable in the archive, in order: the compact
    // was a move, not a delete.
    const archived = await sessions.readArchivedGeneration(agent.id, 1);
    expect(archived?.records.map((r) => r.originalSeq)).toEqual(
      Array.from({ length: priorRows }, (_, i) => i + 1),
    );
    cleanup();
  }, 60_000);
});
