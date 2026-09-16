// The settings gates the capability contract was accepted with, on the SERVER
// side of each one. The UI half of the same contract is pinned in
// `shared/src/capability-view.test.ts` and `shared/src/cloud-config.test.ts`,
// where a test runner exists.
//
// What is pinned here:
//
//   gate 1 — the PREVIEW a settings draft produces and the `/status` the same
//            draft produces after it is written resolve to the same thing, and
//            the preview writes nothing and touches no network.
//   gate 3 — an unconfirmed change that would drop a stored value is REFUSED,
//            with every affected field listed, and a provider change alone does
//            not touch the model.
//   gate 4 — a switch to a provider that cannot honour a sandbox override does
//            not silently clear it: the stored value survives, and the clear is
//            announced and confirmed.
//   gate 5 — the transport choice written through the provider entry point is
//            the one `/status` reports (one reader, one writer).
//   gate 6 — a refusal carries its STRUCTURED detail out of the write path, so
//            the HTTP layer can hand the caller more than a status code.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTORCH_DB_PATH = ":memory:";

let prisma: typeof import("../db.js").prisma;
let SessionManager: typeof import("../sessions/SessionManager.js").SessionManager;
let isSettingsInvalidationRejection: typeof import("../sessions/SessionManager.js").isSettingsInvalidationRejection;
let isReasoningRejection: typeof import("../sessions/SessionManager.js").isReasoningRejection;

class StubHub {
  events: Array<Record<string, unknown>> = [];
  sendToSession(_sessionId: string, msg: Record<string, unknown>): void {
    this.events.push(msg);
  }
  broadcast(msg: Record<string, unknown>): void {
    this.events.push(msg);
  }
}

beforeAll(async () => {
  ({ prisma } = await import("../db.js"));
  ({ SessionManager, isSettingsInvalidationRejection, isReasoningRejection } = await import(
    "../sessions/SessionManager.js"
  ));
});

const dirs: string[] = [];
const tempProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "phase5-gates-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function makeProvider(input: {
  kind: string;
  models: string[];
  metadata?: Record<string, unknown>;
}) {
  return prisma.provider.create({
    data: {
      name: `p-${Math.random().toString(36).slice(2)}`,
      kind: input.kind,
      models: input.models,
      apiKey: input.kind === "openai-codex" ? null : "sk-test",
      baseUrl: input.kind === "openai-compat" ? "https://example.invalid/v1" : null,
      metadata: input.metadata ?? {},
    },
  });
}

async function makeAgent(input: {
  providerId: string;
  model: string;
  projectRoot?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return prisma.agent.create({
    data: {
      name: `a-${Math.random().toString(36).slice(2)}`,
      providerId: input.providerId,
      model: input.model,
      projectRoot: input.projectRoot ?? null,
      systemPrompt: "You are a test agent.",
      metadata: input.metadata ?? {},
    },
  });
}

const session = () => new SessionManager(new StubHub() as never);

/** The resolved value of every settings row, keyed by field — the comparison
 *  gate 1 is stated in terms of. */
const resolutionsOf = (view: { settings: Array<{ field: string; resolved: string | null }> }) =>
  Object.fromEntries(view.settings.map((row) => [row.field, row.resolved]));

describe("gate 1: the preview and the write resolve the same draft", () => {
  it("resolves identically, writes nothing, and touches no network", async () => {
    const provider = await makeProvider({ kind: "openai-compat", models: ["gpt-5.6-luna", "gpt-5.5"] });
    const projectRoot = tempProject();
    const agent = await makeAgent({
      providerId: provider.id,
      model: "gpt-5.6-luna",
      projectRoot,
      metadata: { reasoningEffort: "xhigh", maxRunDurationMs: 120_000 },
    });
    const sessions = session();

    // No probe may run during a preview: a settings draft is not a turn, and a
    // status read that hit the network would make the form's behaviour depend on
    // which endpoint answered.
    const fetchSpy = vi.fn(() => {
      throw new Error("network access during a read-only preview");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const before = await prisma.agent.findUnique({ where: { id: agent.id } });
    const impact = await sessions.agentSettingsImpact(agent.id, {
      model: "gpt-5.5",
      maxRunDurationMs: 240_000,
    });
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(impact).not.toBeNull();
    expect(impact!.nextPlan).not.toBeNull();
    // A draft is labelled as one: nothing about it may render like a record.
    expect(impact!.nextPlan!.source).toBe("preview");
    expect(impact!.resolutionError).toBeNull();
    // Nothing was written — not the model, not the ceiling, not any metadata.
    expect(after).toEqual(before);

    // Now the SAME draft, really applied.
    await sessions.patchAgent(agent.id, { model: "gpt-5.5", maxRunDurationMs: 240_000 });
    const status = await sessions.getStatusReport(agent.id);
    expect(status).not.toBeNull();

    expect(resolutionsOf(status!.planView!)).toEqual(resolutionsOf(impact!.nextPlan!));
    // …and the plan identity a header reads is the same too.
    expect(status!.planView!.identity).toEqual(impact!.nextPlan!.identity);
    expect(status!.planView!.context).toEqual(impact!.nextPlan!.context);
    expect(status!.planView!.transport).toEqual(impact!.nextPlan!.transport);
    expect(status!.planView!.projectRoot).toEqual(impact!.nextPlan!.projectRoot);
  });

  it("reports the draft the form is about, not the agent's current one", async () => {
    const provider = await makeProvider({ kind: "openai-compat", models: ["gpt-5.6-luna", "gpt-5.5"] });
    const agent = await makeAgent({
      providerId: provider.id,
      model: "gpt-5.6-luna",
      projectRoot: tempProject(),
      metadata: { reasoningEffort: "max" },
    });
    const sessions = session();

    const impact = await sessions.agentSettingsImpact(agent.id, { model: "gpt-5.5" });
    // `max` is in luna's ladder and NOT in gpt-5.5's, so the draft cannot carry
    // it — and the row says so instead of showing the current value.
    const reasoning = impact!.nextPlan!.settings.find((row) => row.field === "reasoning")!;
    expect(reasoning.resolved).toBeNull();
    expect(reasoning.outcome).not.toBe("applied");
  });
});

describe("gate 3: an unconfirmed loss is refused, and the model is not collateral", () => {
  it("lists EVERY affected field and writes nothing until they are confirmed", async () => {
    const codex = await makeProvider({ kind: "openai-codex", models: ["gpt-5.6-sol"] });
    const compat = await makeProvider({ kind: "openai-compat", models: ["gpt-5.6-luna"] });
    const agent = await makeAgent({
      providerId: codex.id,
      model: "gpt-5.6-sol",
      projectRoot: tempProject(),
      // `ultra` exists on sol and NOT on luna; the sandbox override only means
      // anything on a codex provider. One provider switch invalidates both.
      metadata: { sandboxMode: "workspace-write", reasoningEffort: "ultra" },
    });
    const sessions = session();

    const impact = await sessions.agentSettingsImpact(agent.id, {
      providerId: compat.id,
      model: "gpt-5.6-luna",
    });
    expect(impact!.requiresConfirmation).toBe(true);
    expect(new Set(impact!.invalidated.map((i) => i.field))).toEqual(new Set(["sandbox", "reasoning"]));
    for (const entry of impact!.invalidated) {
      expect(entry.current).toBeTruthy();
      expect(entry.next).toBeNull();
      expect(entry.code).not.toBe("");
      expect(entry.reason).not.toBe("");
    }

    // Submitting it WITHOUT the confirmation is refused wholesale.
    await expect(
      sessions.patchAgent(agent.id, { providerId: compat.id, model: "gpt-5.6-luna" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(isSettingsInvalidationRejection(err)).toBe(true);
      if (!isSettingsInvalidationRejection(err)) return false;
      // The refusal carries the SAME report the preflight produced.
      expect(new Set(err.impact.invalidated.map((i) => i.field))).toEqual(new Set(["sandbox", "reasoning"]));
      return true;
    });
    // Nothing was written: neither the provider, nor the two values.
    const untouched = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(untouched!.providerId).toBe(codex.id);
    expect(untouched!.metadata).toMatchObject({ sandboxMode: "workspace-write", reasoningEffort: "ultra" });

    // Confirmed: the write goes through, and the announced values are gone.
    const updated = await sessions.patchAgent(agent.id, {
      providerId: compat.id,
      model: "gpt-5.6-luna",
      confirmInvalidated: ["sandbox", "reasoning"],
    });
    expect(updated!.providerId).toBe(compat.id);
    expect(updated!.sandboxMode).toBeNull();
    expect(updated!.reasoningEffort).toBeNull();
  });

  it("does not clear the model just because a provider was selected", async () => {
    const codex = await makeProvider({ kind: "openai-codex", models: [] });
    const compat = await makeProvider({ kind: "openai-compat", models: [] });
    const agent = await makeAgent({ providerId: codex.id, model: "gpt-5.6-sol", projectRoot: tempProject() });
    const sessions = session();

    // The form sends no model when the new provider's list is empty. That must
    // leave the stored model ALONE — a provider switch is not a model choice.
    const updated = await sessions.patchAgent(agent.id, { providerId: compat.id });
    expect(updated!.model).toBe("gpt-5.6-sol");
  });
});

describe("gate 4: a switch that cannot honour a stored override keeps it", () => {
  it("does not silently clear the sandbox override, and clears it only on confirmation", async () => {
    const codex = await makeProvider({ kind: "openai-codex", models: ["gpt-5.6-sol"] });
    const compat = await makeProvider({ kind: "openai-compat", models: ["gpt-5.6-sol"] });
    const agent = await makeAgent({
      providerId: codex.id,
      model: "gpt-5.6-sol",
      projectRoot: tempProject(),
      metadata: { sandboxMode: "danger-full-access" },
    });
    const sessions = session();

    // The payload the form sends for a provider that does not support the
    // override: NO `sandboxMode` key at all. Sending `null` used to clear the
    // user's setting with no prompt, which is the bug this gate is about.
    await expect(sessions.patchAgent(agent.id, { providerId: compat.id })).rejects.toSatisfy((err: unknown) => {
      if (!isSettingsInvalidationRejection(err)) return false;
      expect(err.impact.invalidated.map((i) => i.field)).toContain("sandbox");
      expect(err.impact.invalidated[0]!.current).toBe("danger-full-access");
      return true;
    });

    const stillThere = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(stillThere!.metadata).toMatchObject({ sandboxMode: "danger-full-access" });

    const confirmed = await sessions.patchAgent(agent.id, {
      providerId: compat.id,
      confirmInvalidated: ["sandbox"],
    });
    expect(confirmed!.providerId).toBe(compat.id);
    expect(confirmed!.sandboxMode).toBeNull();
  });
});

describe("gate 5: the transport choice is written and read through one reader", () => {
  it("reports from /status exactly what the provider entry point stored", async () => {
    const provider = await makeProvider({
      kind: "openai-compat",
      models: ["gpt-5.6-luna"],
      metadata: { transport: "chat-completions" },
    });
    const agent = await makeAgent({ providerId: provider.id, model: "gpt-5.6-luna", projectRoot: tempProject() });

    const status = await session().getStatusReport(agent.id);
    expect(status!.planView!.transport.requested).toBe("chat-completions");
    // The settings row and the transport plan are the same answer.
    const row = status!.planView!.settings.find((r) => r.field === "transport")!;
    expect(row.requested).toBe("chat-completions");
    expect(row.resolved).toBe("chat-completions");
  });
});

describe("gate 6: a refusal keeps its structure", () => {
  it("throws the model, the requested level, the ladder and the source", async () => {
    const provider = await makeProvider({ kind: "openai-compat", models: ["gpt-5.6-luna"] });
    const agent = await makeAgent({
      providerId: provider.id,
      model: "gpt-5.6-luna",
      projectRoot: tempProject(),
    });
    const sessions = session();

    await expect(
      sessions.patchAgent(agent.id, { reasoningEffort: "ultra" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(isReasoningRejection(err)).toBe(true);
      if (!isReasoningRejection(err)) return false;
      // Every field the HTTP layer spreads into its 400 body. Losing any one of
      // them turns an actionable refusal into a status code the UI can only
      // render as "something failed".
      expect(err.detail.code).toBe("REASONING_EFFORT_UNSUPPORTED");
      expect(err.detail.requested).toBe("ultra");
      expect(err.detail.model).toBe("gpt-5.6-luna");
      expect(err.detail.supportedLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(err.detail.source).not.toBe("");
      expect(err.detail.reason).toContain("ultra");
      return true;
    });

    // And the preview refuses the same value with the same code, BEFORE the
    // user submits it — a structured 400 the form can pre-empt.
    const impact = await sessions.agentSettingsImpact(agent.id, { reasoningEffort: "ultra" });
    expect(impact!.rejection).toMatchObject({ field: "reasoning", code: "REASONING_EFFORT_UNSUPPORTED" });
    expect(impact!.rejection!.detail).not.toBe("");
  });
});
