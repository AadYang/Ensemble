import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexExecArgs,
  buildCodexInternalStdioServerConfig,
  buildCodexRuntimeErrorEvent,
  buildCodexMcpListArgs,
  buildCurrentTurnPrompt,
  isCodexEventStreamLagged,
  prepareCodexHomeForRuntime,
  renderMcpConfigTomlForCodexRuntime,
} from "../codex.js";
import { DATA_DIR } from "../../../paths.js";

let tempRoots: string[] = [];
let runtimeSessionIds: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  process.env.CODEX_HOME = originalCodexHome;
  for (const id of runtimeSessionIds) rmSync(join(DATA_DIR, "codex-runtime", id), { recursive: true, force: true });
  runtimeSessionIds = [];
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots = [];
});

describe("Codex runtime isolated CODEX_HOME", () => {
  it("builds direct codex exec JSON args for new turns without obsolete builtin_mcp", () => {
    expect(buildCodexExecArgs({
      cwd: "D:\\WorkSpace\\Repo",
      model: "gpt-5.5",
      promptFromStdin: true,
      sandbox: "workspace-write",
    })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-c",
      "approval_policy=\"never\"",
      "-c",
      "sandbox_mode=\"workspace-write\"",
      "--disable",
      "apps",
      "--cd",
      "D:\\WorkSpace\\Repo",
      "--sandbox",
      "workspace-write",
      "-",
    ]);
  });

  it("passes sandbox_mode via -c on resume turns (no --sandbox / --cd accepted)", () => {
    // Regression: previously the resume branch dropped the sandbox entirely,
    // so Codex silently downgraded to read-only after the first turn even
    // when the user selected danger-full-access. The `-c sandbox_mode` config
    // override works on both `exec` and `exec resume`, so the runtime now
    // forwards the choice symmetrically.
    expect(buildCodexExecArgs({
      cwd: "D:\\WorkSpace\\Repo",
      model: "gpt-5.5",
      promptFromStdin: true,
      resume: "018f0000-0000-7000-8000-000000000000",
      sandbox: "danger-full-access",
    })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.5",
      "-c",
      "approval_policy=\"never\"",
      "-c",
      "sandbox_mode=\"danger-full-access\"",
      "--disable",
      "apps",
      "018f0000-0000-7000-8000-000000000000",
      "-",
    ]);
  });

  it("passes reasoning effort via -c on new and resume turns", () => {
    expect(buildCodexExecArgs({
      cwd: "D:\\WorkSpace\\Repo",
      model: "gpt-5.5",
      promptFromStdin: true,
      sandbox: "workspace-write",
      reasoningEffort: "xhigh",
    })).toEqual(expect.arrayContaining([
      "-c",
      "model_reasoning_effort=\"xhigh\"",
    ]));

    expect(buildCodexExecArgs({
      cwd: "D:\\WorkSpace\\Repo",
      model: "gpt-5.5",
      promptFromStdin: true,
      resume: "018f0000-0000-7000-8000-000000000000",
      reasoningEffort: "low",
    })).toEqual(expect.arrayContaining([
      "-c",
      "model_reasoning_effort=\"low\"",
    ]));
  });

  it("builds codex mcp list args without the obsolete builtin_mcp flag", () => {
    expect(buildCodexMcpListArgs()).toEqual(["mcp", "--disable", "apps", "list"]);
  });

  it("wraps Codex prompts with a current-turn boundary", () => {
    const prompt = buildCurrentTurnPrompt("fix B, not A");
    expect(prompt).toContain("<current-user-request>");
    expect(prompt).toContain("fix B, not A");
    expect(prompt).toContain("Do not resume, hand off, or continue older tasks");
  });

  it("marks interrupted native resume turns with structured recovery metadata", () => {
    expect(buildCodexRuntimeErrorEvent("closed before completion", {
      usedNativeResume: true,
      turnStarted: true,
      turnCompleted: false,
    })).toEqual({
      type: "error",
      message: "closed before completion",
      code: "RESUME_TURN_INTERRUPTED",
      recoverable: true,
      resumeScoped: true,
    });

    expect(buildCodexRuntimeErrorEvent("provider failed", {
      usedNativeResume: false,
      turnStarted: true,
      turnCompleted: false,
    })).toEqual({
      type: "error",
      message: "provider failed",
    });
  });

  it("marks Codex app-server event stream lag as recoverable", () => {
    const message = "QUERY_FAILED · in-process app-server event stream lagged; dropped events";

    expect(isCodexEventStreamLagged(message)).toBe(true);
    expect(buildCodexRuntimeErrorEvent(message, {
      usedNativeResume: false,
      turnStarted: true,
      turnCompleted: false,
    })).toEqual({
      type: "error",
      message,
      code: "CODEX_EVENT_STREAM_LAGGED",
      recoverable: true,
      resumeScoped: false,
    });
  });

  it("builds a stdio MCP config for the internal Codex bridge", () => {
    const cfg = buildCodexInternalStdioServerConfig({
      ENSEMBLE_MCP_BASE_URL: "http://127.0.0.1:12345",
      ENSEMBLE_MCP_AGENT_ID: "agent-1",
      ENSEMBLE_MCP_BEARER: "token",
    });
    expect(cfg.command).toBe(process.execPath);
    expect(cfg.args).toEqual(expect.arrayContaining([expect.stringContaining("codex-stdio-mcp.ts")]));
    expect(cfg.env).toEqual(expect.objectContaining({ ENSEMBLE_MCP_AGENT_ID: "agent-1" }));
  });

  it("renders only Ensemble-owned MCP config", () => {
    const toml = renderMcpConfigTomlForCodexRuntime(
      {
        "agentorch-internal-abcd1234": {
          url: "http://127.0.0.1:1234/api/mcp/internal/agent",
          bearer_token_env_var: "ENSEMBLE_MCP_BEARER",
        },
        "external.server": {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "x" },
        },
      },
      ["D:\\WorkSpace\\Repo"],
    );

    expect(toml).toContain("[features]");
    expect(toml).toContain("approval_policy = \"never\"");
    expect(toml).toContain("apps = false");
    expect(toml).not.toContain("builtin_mcp");
    expect(toml).toContain("[projects.\"D:\\\\WorkSpace\\\\Repo\"]");
    expect(toml).toContain("trust_level = \"trusted\"");
    expect(toml).toContain("[mcp_servers.agentorch-internal-abcd1234]");
    expect(toml).toContain("[mcp_servers.\"external.server\"]");
    expect(toml).toContain("[mcp_servers.\"external.server\".env]");
    expect(toml).toContain("TOKEN = \"x\"");
    // No sandbox_mode line when caller doesn't supply one (provider default
    // path or non-Codex provider).
    expect(toml).not.toContain("sandbox_mode");
  });

  it("writes sandbox_mode into config.toml when supplied", () => {
    // Regression: see the resume-turn test above. Pinning sandbox_mode in the
    // isolated config.toml means a resumed Codex turn (which can't take a
    // --sandbox CLI flag) still honors the agent's chosen sandbox instead of
    // silently downgrading to Codex's read-only default.
    const toml = renderMcpConfigTomlForCodexRuntime(
      {
        "agentorch-internal-abcd1234": {
          url: "http://127.0.0.1:1234/api/mcp/internal/agent",
        },
      },
      [],
      "danger-full-access",
    );
    expect(toml).toContain("sandbox_mode = \"danger-full-access\"");
  });

  it("writes model_reasoning_effort into config.toml when supplied", () => {
    const toml = renderMcpConfigTomlForCodexRuntime(
      {
        "agentorch-internal-abcd1234": {
          url: "http://127.0.0.1:1234/api/mcp/internal/agent",
        },
      },
      [],
      null,
      "xhigh",
    );
    expect(toml).toContain("model_reasoning_effort = \"xhigh\"");
  });

  it("does not duplicate inherited model_reasoning_effort when an agent override is supplied", () => {
    const toml = renderMcpConfigTomlForCodexRuntime(
      {
        "agentorch-internal-abcd1234": {
          url: "http://127.0.0.1:1234/api/mcp/internal/agent",
        },
      },
      [],
      null,
      "xhigh",
      [
        "model_provider = \"openai\"",
        "model_reasoning_effort = \"low\"",
        "",
        "[model_providers.openai]",
        "name = \"OpenAI\"",
      ].join("\n"),
    );
    const matches = toml.match(/^model_reasoning_effort\s*=/gm) ?? [];
    expect(matches).toHaveLength(1);
    expect(toml).toContain("model_reasoning_effort = \"xhigh\"");
    expect(toml).not.toContain("model_reasoning_effort = \"low\"");
  });

  it("copies auth.json and connection settings without stale user MCP config", () => {
    const sessionId = `test-agent-${Date.now()}-1`;
    const sourceHome = mkdtempSync(join(tmpdir(), "ensemble-source-codex-"));
    tempRoots.push(sourceHome);
    runtimeSessionIds.push(sessionId);
    mkdirSync(sourceHome, { recursive: true });
    writeFileSync(join(sourceHome, "auth.json"), "{\"token\":\"secret\"}", "utf8");
    writeFileSync(
      join(sourceHome, "config.toml"),
      [
        "model_provider = \"timi_cc\"",
        "model = \"gpt-5.5\"",
        "model_reasoning_effort = \"xhigh\"",
        "approval_policy = \"on-request\"",
        "sandbox_mode = \"read-only\"",
        "",
        "[model_providers.timi_cc]",
        "name = \"timi_cc\"",
        "base_url = \"https://timicc.com\"",
        "wire_api = \"responses\"",
        "requires_openai_auth = true",
        "",
        "[projects.\"/tmp/old\"]",
        "trust_level = \"trusted\"",
        "",
        "[mcp_servers.stale]",
        "url = \"http://broken\"",
      ].join("\n"),
      "utf8",
    );

    const runtimeHome = prepareCodexHomeForRuntime(
      sessionId,
      {
        "agentorch-internal-agent1": {
          url: "http://127.0.0.1:1234/api/mcp/internal/agent-1",
          bearer_token_env_var: "ENSEMBLE_MCP_BEARER",
        },
      },
      sourceHome,
      "D:\\WorkSpace\\Repo",
    );

    expect(readFileSync(join(runtimeHome, "auth.json"), "utf8")).toBe("{\"token\":\"secret\"}");
    const runtimeConfig = readFileSync(join(runtimeHome, "config.toml"), "utf8");
    expect(runtimeConfig).toContain("model_provider = \"timi_cc\"");
    expect(runtimeConfig).toContain("model_reasoning_effort = \"xhigh\"");
    expect(runtimeConfig).toContain("[model_providers.timi_cc]");
    expect(runtimeConfig).toContain("base_url = \"https://timicc.com\"");
    expect(runtimeConfig).toContain("requires_openai_auth = true");
    expect(runtimeConfig).toContain("approval_policy = \"never\"");
    expect(runtimeConfig).toContain("[mcp_servers.agentorch-internal-agent1]");
    expect(runtimeConfig).not.toContain("mcp_servers.stale");
    expect(runtimeConfig).not.toContain("http://broken");
    expect(runtimeConfig).not.toContain("[projects.\"/tmp/old\"]");
    expect(runtimeConfig).not.toContain("sandbox_mode = \"read-only\"");
    expect(runtimeConfig).toContain("trust_level = \"trusted\"");
  });

  it("still creates isolated config when the user has not logged in", () => {
    const sessionId = `test-agent-${Date.now()}-2`;
    const sourceHome = mkdtempSync(join(tmpdir(), "ensemble-source-codex-"));
    tempRoots.push(sourceHome);
    runtimeSessionIds.push(sessionId);

    const runtimeHome = prepareCodexHomeForRuntime(
      sessionId,
      { "agentorch-internal-agent2": { url: "http://127.0.0.1:1234/api/mcp/internal/agent-2" } },
      sourceHome,
    );

    expect(existsSync(join(runtimeHome, "auth.json"))).toBe(false);
    expect(readFileSync(join(runtimeHome, "config.toml"), "utf8")).toContain(
      "[mcp_servers.agentorch-internal-agent2]",
    );
  });

  it("does not use parent CODEX_HOME as the default auth source", () => {
    const sessionId = `test-agent-${Date.now()}-3`;
    const parentCodexHome = mkdtempSync(join(tmpdir(), "ensemble-parent-codex-"));
    tempRoots.push(parentCodexHome);
    runtimeSessionIds.push(sessionId);
    writeFileSync(join(parentCodexHome, "auth.json"), "{\"token\":\"parent\"}", "utf8");
    process.env.CODEX_HOME = parentCodexHome;

    const runtimeHome = prepareCodexHomeForRuntime(
      sessionId,
      { "agentorch-internal-agent3": { url: "http://127.0.0.1:1234/api/mcp/internal/agent-3" } },
    );

    const runtimeAuth = join(runtimeHome, "auth.json");
    if (existsSync(runtimeAuth)) {
      expect(readFileSync(runtimeAuth, "utf8")).not.toBe("{\"token\":\"parent\"}");
    }
    expect(readFileSync(join(runtimeHome, "config.toml"), "utf8")).toContain("apps = false");
  });
});
