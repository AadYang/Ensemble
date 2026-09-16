// Phase 2 contract: ONE canonical project root, and the rules that keep it
// single. The list this file covers, in the order the batch states it:
//
//   • the migration is idempotent and never invents a root for a NULL row
//   • the legacy `codexWorkspace` alias translates, and a contradictory pair is
//     refused rather than resolved by field order
//   • the plan's projectRoot is the ONLY source of a turn's cwd, on all three
//     runtimes
//   • an unbound agent runs in its OWN scratch dir — never the home dir and
//     never the process's cwd
//   • a configured root that has since vanished REFUSES the turn instead of
//     falling back, while `/status` still reports it (with the reason)
//   • changing the root clears the native resume pointer
//   • a subagent inherits the parent's root verbatim, may override it, and an
//     invalid override is refused
//   • the API runtime gets the project's instructions exactly once; the native
//     runtimes get them from their own CLI, not from us

// MUST come first: it sets the data dir before anything resolves it. See the
// module's own header for why a plain assignment below the imports would not do.
import "./project-root-env.js";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { RuntimeOptions } from "../runtimes/types.js";
import { __setSkillsForTest } from "../../skills/index.js";

const capturedRuntimeOptions: RuntimeOptions[] = [];

vi.mock("../runtimes/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtimes/index.js")>()),
  chooseRuntime: () => ({
    async *query(opts: RuntimeOptions) {
      capturedRuntimeOptions.push(opts);
      yield {
        type: "sdk_message" as const,
        payload: {
          type: "result" as const,
          subtype: "success",
          session_id: `thread-${capturedRuntimeOptions.length}`,
          modelUsage: {},
        },
      };
    },
  }),
}));

vi.mock("../../cli-config.js", () => ({
  getClaudeCliPath: vi.fn(async () => "mock-claude"),
  getCodexCliPath: vi.fn(async () => "mock-codex"),
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
let backfillProjectRoot: typeof import("../../db.js").backfillProjectRoot;
let SessionManager: typeof import("../SessionManager.js").SessionManager;
let projectRoot: typeof import("../project-root.js");

const projectDirs: string[] = [];

/** A real directory, so a "bound" root is genuinely inspectable. */
function makeProjectDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ensemble-project-${tag}-`));
  projectDirs.push(dir);
  return dir;
}

/** Run a write-path call that must be refused and return its structured code. */
function rejectionCode(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as { code?: string }).code ?? "(no code)";
  }
  return "(no rejection)";
}

/** Same, for the callers that also want to inspect the rejection. */
function rejection<T extends object>(expected: string, run: () => unknown): T {
  try {
    run();
  } catch (err) {
    const code = (err as { code?: string }).code;
    expect(code).toBe(expected);
    return err as T;
  }
  throw new Error(`expected a ${expected} rejection`);
}

beforeAll(async () => {
  ({ prisma, backfillProjectRoot } = await import("../../db.js"));
  ({ SessionManager } = await import("../SessionManager.js"));
  projectRoot = await import("../project-root.js");
});

beforeEach(() => {
  capturedRuntimeOptions.length = 0;
  __setSkillsForTest([]);
});

describe("SQLite migration", () => {
  it("backfills only a non-empty legacy value and stays idempotent", async () => {
    const bound = await prisma.agent.create({
      data: {
        name: "legacy-bound",
        // The legacy column is written directly here: this is the pre-migration
        // row shape the backfill exists for.
        codexWorkspace: "/tmp/legacy-project",
      } as never,
    });
    const emptyLegacy = await prisma.agent.create({
      data: { name: "legacy-empty", codexWorkspace: "" } as never,
    });
    const neverBound = await prisma.agent.create({ data: { name: "never-bound" } });

    const first = backfillProjectRoot();
    expect(first.count).toBeGreaterThanOrEqual(1);

    const boundAfter = await prisma.agent.findUnique({ where: { id: bound.id } });
    expect(boundAfter?.projectRoot).toBe("/tmp/legacy-project");
    // NULL / empty is an ANSWER (unbound), not a gap to fill: inventing a
    // directory for these rows would move an agent's work somewhere the user
    // never chose.
    expect((await prisma.agent.findUnique({ where: { id: emptyLegacy.id } }))?.projectRoot).toBeNull();
    expect((await prisma.agent.findUnique({ where: { id: neverBound.id } }))?.projectRoot).toBeNull();

    const second = backfillProjectRoot();
    expect(second.count).toBe(0);
    expect((await prisma.agent.findUnique({ where: { id: bound.id } }))?.projectRoot).toBe(
      "/tmp/legacy-project",
    );
  });

  it("does not resurrect an explicit unbind", async () => {
    const agent = await prisma.agent.create({
      data: { name: "unbind", codexWorkspace: "/tmp/legacy-two" } as never,
    });
    backfillProjectRoot();
    const sessions = new SessionManager(new StubHub() as never);
    // The user clears the field.
    await sessions.patchAgent(agent.id, { projectRoot: null });
    // The next boot's backfill must not read the leftover legacy value as "not
    // yet migrated" and rebind the agent the user just unbound.
    backfillProjectRoot();
    const after = await prisma.agent.findUnique({ where: { id: agent.id } });
    expect(after?.projectRoot).toBeNull();
    expect(after?.codexWorkspace).toBeNull();
  });
});

describe("the write path", () => {
  it("translates the legacy alias and refuses a contradictory pair", () => {
    const dir = makeProjectDir("alias");
    expect(projectRoot.reconcileProjectRootInput(undefined, dir)).toBe(dir);
    expect(projectRoot.reconcileProjectRootInput(dir, undefined)).toBe(dir);
    expect(projectRoot.reconcileProjectRootInput(dir, dir)).toBe(dir);
    // Same field, two answers: refused, not resolved by picking one.
    expect(rejection("PROJECT_ROOT_CONFLICT", () => projectRoot.reconcileProjectRootInput(dir, makeProjectDir("other")))).toMatchObject({
      code: "PROJECT_ROOT_CONFLICT",
    });
  });

  it("compares directory IDENTITY, not spelling", () => {
    const dir = makeProjectDir("identity");
    // One directory, written several ways: a trailing separator, a `.`
    // segment. None of these is a different project, and refusing them would
    // mean a caller that normalizes differently cannot save its own field.
    const sameSpellings = [dir + sep, join(dir, "."), `${dir}${sep}.`];
    if (process.platform === "win32") {
      // Windows volumes are case-insensitive, so a case fix is not a move.
      sameSpellings.push(dir.toUpperCase(), dir.replace(/\\/g, "/"));
    }
    for (const spelling of sameSpellings) {
      expect(projectRoot.reconcileProjectRootInput(dir, spelling)).toBe(dir);
      expect(projectRoot.isSameProjectRoot(dir, spelling)).toBe(true);
    }
    // Two directories are still two directories, whatever the spelling.
    const other = makeProjectDir("identity-other");
    expect(rejectionCode(() => projectRoot.reconcileProjectRootInput(dir, other))).toBe(
      "PROJECT_ROOT_CONFLICT",
    );
    expect(projectRoot.isSameProjectRoot(dir, other)).toBe(false);
    // Unbinding while the alias still names a directory is a real disagreement
    // (bind vs no bind), not an equivalent spelling.
    expect(rejectionCode(() => projectRoot.reconcileProjectRootInput(null, dir))).toBe(
      "PROJECT_ROOT_CONFLICT",
    );
  });

  it("rejects a path that is relative, missing, or not a directory", () => {
    const file = join(makeProjectDir("file"), "a.txt");
    writeFileSync(file, "x");
    // The CODE is the contract (the API/WS hand it to the client verbatim); the
    // human sentence next to it is free to change.
    expect(rejectionCode(() => projectRoot.normalizeProjectRoot("relative/path"))).toBe(
      "PROJECT_ROOT_NOT_ABSOLUTE",
    );
    expect(
      rejectionCode(() =>
        projectRoot.normalizeProjectRoot(join(tmpdir(), "ensemble-definitely-missing-xyz")),
      ),
    ).toBe("PROJECT_ROOT_NOT_FOUND");
    expect(rejectionCode(() => projectRoot.normalizeProjectRoot(file))).toBe(
      "PROJECT_ROOT_NOT_A_DIRECTORY",
    );
    // Every one of them is recognizable, so the API layer can turn it into a
    // declared 4xx instead of an anonymous 500.
    try {
      projectRoot.normalizeProjectRoot("relative/path");
    } catch (err) {
      expect(projectRoot.isProjectRootRejection(err)).toBe(true);
    }
  });

  it("treats null / empty as an explicit unbind", () => {
    expect(projectRoot.normalizeProjectRoot(null)).toBeNull();
    expect(projectRoot.normalizeProjectRoot("   ")).toBeNull();
    // `undefined` is "the caller said nothing" — a different answer.
    expect(projectRoot.normalizeProjectRoot(undefined)).toBeUndefined();
  });
});

describe("the plan is the only cwd source", () => {
  it.each(["anthropic-local", "openai-codex", "openai-local"] as const)(
    "hands the %s runtime the plan's project root",
    async (kind) => {
      const dir = makeProjectDir(kind);
      const provider = await prisma.provider.create({
        data: {
          name: `cwd-${kind}`,
          kind,
          models: ["test-model"],
          apiKey: kind === "openai-local" ? "sk-test" : null,
          metadata: kind === "openai-codex" ? { defaultSandbox: "danger-full-access" } : {},
        },
      });
      const agent = await prisma.agent.create({
        data: { name: `cwd-agent-${kind}`, providerId: provider.id, model: "test-model", projectRoot: dir },
      });
      const sessions = new SessionManager(new StubHub() as never);

      await sessions.sendMessage(agent.id, "hello");

      const opts = capturedRuntimeOptions[0]!;
      expect(opts.runPlan.execution.projectRoot.value).toBe(dir);
      expect(opts.runPlan.execution.projectRoot.source).toBe("agent");
      expect(opts.runPlan.execution.projectRoot.state).toBe("bound");
      // The channel that used to carry a second answer is gone entirely.
      expect("cwd" in opts).toBe(false);
      const status = await sessions.getStatusReport(agent.id);
      expect(status?.runtimeCwd).toBe(dir);
    },
  );

  it("runs an unbound agent in its OWN scratch dir, not home and not process.cwd", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "scratch-provider",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: { name: "unbound", providerId: provider.id, model: "test-model" },
    });
    const sessions = new SessionManager(new StubHub() as never);

    await sessions.sendMessage(agent.id, "hello");

    const cwd = capturedRuntimeOptions[0]!.runPlan.execution.projectRoot;
    expect(cwd.state).toBe("unbound");
    expect(cwd.source).toBe("scratch");
    expect(cwd.value).toBe(projectRoot.scratchDirFor(agent.id));
    // No process-wide default, ever: neither the sidecar's own directory nor
    // the user's home is an acceptable stand-in for a project.
    expect(cwd.value).not.toBe(process.cwd());
    expect(cwd.value).not.toBe(process.env.HOME ?? process.env.USERPROFILE ?? "");
  });

  it("refuses the turn when the configured root has vanished, and still reports it", async () => {
    const dir = makeProjectDir("vanishing");
    const provider = await prisma.provider.create({
      data: {
        name: "vanishing-provider",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: { name: "vanishing", providerId: provider.id, model: "test-model", projectRoot: dir },
    });
    const hub = new StubHub();
    const sessions = new SessionManager(hub as never);

    // The directory disappears between the write and the turn.
    rmSync(dir, { recursive: true, force: true });

    const result = await sessions.sendMessage(agent.id, "hello");
    expect(result).toBeNull();
    // Refused, NOT silently re-homed into scratch.
    expect(capturedRuntimeOptions).toHaveLength(0);
    const error = hub.events.find((e) => e.msg.type === "error")?.msg;
    expect(error?.code).toBe("PROJECT_ROOT_NOT_FOUND");

    // `/status` still answers, and says which rule failed and why.
    const status = await sessions.getStatusReport(agent.id);
    expect(status?.projectRootState?.state).toBe("bound");
    expect(status?.projectRootState?.invalid?.code).toBe("PROJECT_ROOT_NOT_FOUND");
    expect(status?.projectRootState?.invalid?.reason).toContain(dir);
    expect(status?.runtimeCwd).toBeNull();
  });

  it("clears the native resume pointer when the root changes", async () => {
    const before = makeProjectDir("resume-a");
    const after = makeProjectDir("resume-b");
    const provider = await prisma.provider.create({
      data: {
        name: "resume-provider",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: {
        name: "resume-agent",
        providerId: provider.id,
        model: "test-model",
        projectRoot: before,
        metadata: { lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79" },
      },
    });
    const sessions = new SessionManager(new StubHub() as never);

    // A patch that names the SAME directory must NOT drop the pointer: nothing
    // moved, so there is nothing to invalidate.
    await sessions.patchAgent(agent.id, { projectRoot: before });
    expect((await prisma.agent.findUnique({ where: { id: agent.id } }))?.metadata).toMatchObject({
      lastSessionId: "019ea530-56b8-7163-8b3c-5bd5ae5c2c79",
    });

    await sessions.patchAgent(agent.id, { projectRoot: after });
    const meta = (await prisma.agent.findUnique({ where: { id: agent.id } }))?.metadata as Record<
      string,
      unknown
    >;
    expect(meta.lastSessionId).toBeUndefined();
  });
});

describe("subagents", () => {
  async function parentAgent(kind = "openai-codex") {
    const provider = await prisma.provider.create({
      data: {
        name: `sub-${kind}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        models: ["test-model"],
        apiKey: kind === "openai-local" ? "sk-test" : null,
        metadata: kind === "openai-codex" ? { defaultSandbox: "danger-full-access" } : {},
      },
    });
    return prisma.agent.create({
      data: {
        name: "sub-parent",
        providerId: provider.id,
        model: "test-model",
        projectRoot: makeProjectDir("sub-parent"),
      },
    });
  }

  it("inherits the parent's root verbatim when no override is passed", async () => {
    const parent = await parentAgent();
    const sessions = new SessionManager(new StubHub() as never);

    const { subagentId } = await sessions.spawnTaskSubagent(parent.id, "inherit", "do work");

    const child = await prisma.agent.findUnique({ where: { id: subagentId } });
    expect(child?.projectRoot).toBe(parent.projectRoot);
    expect(child?.parentId).toBe(parent.id);
    // Legacy columns are not copied forward any more.
    expect(child?.workspace).toBeNull();
    expect(child?.codexWorkspace).toBeNull();
  });

  it("accepts a validated override and refuses an invalid one", async () => {
    const parent = await parentAgent();
    const sessions = new SessionManager(new StubHub() as never);
    const other = makeProjectDir("sub-other");

    const { subagentId } = await sessions.spawnTaskSubagent(parent.id, "override", "do work", {
      projectRoot: other,
    });
    expect((await prisma.agent.findUnique({ where: { id: subagentId } }))?.projectRoot).toBe(other);

    // The override goes through the SAME write-path validation as a user-set
    // root, so a subagent cannot be pointed at a directory that does not exist.
    await expect(
      sessions.spawnTaskSubagent(parent.id, "bad override", "do work", {
        projectRoot: join(tmpdir(), "ensemble-no-such-sub-project"),
      }),
    ).rejects.toMatchObject({ code: "PROJECT_ROOT_NOT_FOUND" });
  });
});

describe("project instructions", () => {
  it("loads only the files inside the root — no walk-up, no scratch", async () => {
    const { loadProjectInstructions, renderProjectInstructionsBlock } = await import(
      "../project-instructions.js"
    );
    const root = makeProjectDir("instructions");
    const parent = join(root, "..");
    writeFileSync(join(root, "AGENTS.md"), "root-level rules");
    writeFileSync(join(parent, "AGENTS.md"), "PARENT rules that must not leak in");

    const files = loadProjectInstructions(root);
    expect(files.map((f) => f.name)).toEqual(["AGENTS.md"]);
    expect(files[0]!.text).toContain("root-level rules");

    const block = renderProjectInstructionsBlock(files);
    expect(block).toContain("root-level rules");
    expect(block).not.toContain("PARENT rules");

    // Unbound: a scratch dir is a session buffer, not the user's project.
    expect(loadProjectInstructions(null)).toEqual([]);
    expect(renderProjectInstructionsBlock([])).toBeNull();
  });

  it("carries the WHOLE file, not a clipped prefix", async () => {
    const root = makeProjectDir("whole-file");
    // The native CLIs read the file in full, so a shortened copy would give the
    // same project two different rule sets depending on the runtime — and the
    // dropped half is where a user puts the constraints. The marker sits past
    // any plausible character/byte budget.
    const filler = "filler line that is not a rule\n".repeat(2_000);
    writeFileSync(join(root, "AGENTS.md"), `${filler}END-OF-FILE-RULE\n`);

    const provider = await prisma.provider.create({
      data: {
        name: "whole-file-provider",
        kind: "openai-local",
        models: ["test-model"],
        apiKey: "sk-test",
      },
    });
    const agent = await prisma.agent.create({
      data: { name: "whole-file", providerId: provider.id, model: "test-model", projectRoot: root },
    });
    await new SessionManager(new StubHub() as never).sendMessage(agent.id, "hello");

    const prompt = capturedRuntimeOptions[0]!.systemPrompt ?? "";
    expect(prompt).toContain("END-OF-FILE-RULE");
    expect(prompt).not.toContain("[truncated");
  });

  it("refuses the API turn when an existing instruction file cannot be read", async () => {
    const root = makeProjectDir("unreadable-instructions");
    // A directory where the file should be: the name exists, the rules cannot
    // be read. Deterministic on every platform, unlike a permission bit.
    mkdirSync(join(root, "AGENTS.md"));
    const provider = await prisma.provider.create({
      data: {
        name: "unreadable-instructions-provider",
        kind: "openai-local",
        models: ["test-model"],
        apiKey: "sk-test",
      },
    });
    const agent = await prisma.agent.create({
      data: { name: "unreadable", providerId: provider.id, model: "test-model", projectRoot: root },
    });
    const hub = new StubHub();
    const result = await new SessionManager(hub as never).sendMessage(agent.id, "hello");

    expect(result).toBeNull();
    // Not "no instructions, run anyway": this runtime would then work under a
    // different rule set than the native CLIs on the same directory.
    expect(capturedRuntimeOptions).toHaveLength(0);
    expect(hub.events.find((e) => e.msg.type === "error")?.msg.code).toBe(
      "PROJECT_INSTRUCTIONS_UNREADABLE",
    );
  });

  it("leaves instruction loading to Codex, the native runtime that still loads it", async () => {
    // Load-bearing scope check: the refusal above belongs to the runtime that
    // has to inject them. A native CLI deals with its own instruction files,
    // so the same directory must not stop its turn.
    const root = makeProjectDir("unreadable-native");
    mkdirSync(join(root, "AGENTS.md"));
    const provider = await prisma.provider.create({
      data: {
        name: "unreadable-native-provider",
        kind: "openai-codex",
        models: ["test-model"],
        metadata: { defaultSandbox: "danger-full-access" },
      },
    });
    const agent = await prisma.agent.create({
      data: { name: "unreadable-native", providerId: provider.id, model: "test-model", projectRoot: root },
    });
    await new SessionManager(new StubHub() as never).sendMessage(agent.id, "hello");
    expect(capturedRuntimeOptions).toHaveLength(1);
  });

  it("injects the block for the API runtime only, exactly once", async () => {
    const root = makeProjectDir("inject");
    writeFileSync(join(root, "AGENTS.md"), "INJECTED-PROJECT-RULE");

    const expectations = [
      // Claude's adapter supplies a complete string system prompt and disables
      // settingSources, so it cannot rely on the SDK's CLAUDE.md walk-up.
      { kind: "anthropic-local", expectBlock: true },
      // Codex still reads the project's instructions through its own CLI.
      { kind: "openai-codex", expectBlock: false },
      // The in-process HTTP runtime has no directory awareness at all: this is
      // its only channel.
      { kind: "openai-local", expectBlock: true },
    ] as const;

    for (const { kind, expectBlock } of expectations) {
      capturedRuntimeOptions.length = 0;
      const provider = await prisma.provider.create({
        data: {
          name: `instr-${kind}`,
          kind,
          models: ["test-model"],
          apiKey: kind === "openai-local" ? "sk-test" : null,
          metadata: kind === "openai-codex" ? { defaultSandbox: "danger-full-access" } : {},
        },
      });
      const agent = await prisma.agent.create({
        data: { name: `instr-agent-${kind}`, providerId: provider.id, model: "test-model", projectRoot: root },
      });
      const sessions = new SessionManager(new StubHub() as never);
      await sessions.sendMessage(agent.id, "hello");
      const opts = capturedRuntimeOptions[0]!;
      const prompt = opts.systemPrompt ?? "";
      expect(prompt.includes("INJECTED-PROJECT-RULE")).toBe(expectBlock);
      // ONCE, not per part: the composer concatenates sections, so a second
      // inclusion would show up as a second occurrence.
      expect(prompt.split("INJECTED-PROJECT-RULE").length - 1).toBe(expectBlock ? 1 : 0);
    }
  });
});

describe("scratch directories", () => {
  it("are per agent, live under DATA_DIR, and are created on demand", () => {
    const a = projectRoot.ensureScratchDir("agent-a");
    const b = projectRoot.ensureScratchDir("agent-b");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("scratch dirs were not created");
    expect(a.path).not.toBe(b.path);
    // Two unbound agents share no directory, and neither lands in the process's
    // own working directory.
    expect(a.path.startsWith(process.env.AGENTORCH_DATA_DIR!)).toBe(true);
    expect(a.path).not.toBe(process.cwd());
    expect(a.path.endsWith("scratch")).toBe(true);
  });
});
