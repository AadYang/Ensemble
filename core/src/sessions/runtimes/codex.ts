// W20 Slice 5.1 + 5.3: CodexCliRuntime.
//
// Third runtime — parallel to ClaudeAgentRuntime and OpenAIAgentRuntime.
// Drives the user's local `codex` CLI directly in non-interactive JSONL mode.
// We never mutate ~/.codex/config.toml; Ensemble writes an isolated CODEX_HOME
// per agent turn. We invoke the real platform binary, not the npm shell shim.
//
// W20 v2.1 + spike adjustments:
// - sandbox is a per-turn CLI option; when the user
//   explicitly sets a provider/agent sandbox we pass it through. Otherwise we
//   leave it unset so Codex inherits the same config/defaults as the CLI.
// - billingModel = 'subscription' for every codex turn; cost = 0 always.
//   The session manager's UsageEvent write path needs to know this; for
//   now we encode it in the synthesized result message and have the
//   write path interpret kind=openai-codex as subscription.
// - reasoning_output_tokens merges into outputTokens (W20 §2 of spike doc)

import { randomUUID } from "node:crypto";
import { execFile, execSync, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import type { SdkMessage } from "@agentorch/shared";
import type { AgentRuntime, RuntimeEvent, RuntimeOptions } from "./types.js";
import {
  getBridgeBaseUrl,
  getBridgeUrl,
  BRIDGE_TOKEN,
  mcpServersToCodexConfig,
  registerHandlers,
  unregisterHandlers,
} from "../../mcp-bridge.js";
import { getCodexCliPath } from "../../cli-config.js";
import { DATA_DIR, PACKAGED, REPO_ROOT } from "../../paths.js";

// Resolve the user's already-installed Codex binary. The npm shim is often a
// shell script, so we need to locate the native platform executable.
//
// Codex is spawned with shell:false, so we MUST hand it a real executable:
// codex.exe on Windows / unsuffixed ELF on Unix. The
// `where codex` / `which codex` result is usually the npm POSIX shim
// (no .exe), which Node cannot spawn directly on Windows → ENOENT. We
// walk from the shim's directory upward to find the npm-installed platform
// package and locate the real binary inside its vendor/ tree.
let cachedCodexPath: string | null | undefined;

function platformPackageName(): string | null {
  const p = process.platform, a = process.arch;
  if (p === "win32" && a === "x64") return "codex-win32-x64";
  if (p === "win32" && a === "arm64") return "codex-win32-arm64";
  if (p === "darwin" && a === "x64") return "codex-darwin-x64";
  if (p === "darwin" && a === "arm64") return "codex-darwin-arm64";
  if (p === "linux" && a === "x64") return "codex-linux-x64";
  if (p === "linux" && a === "arm64") return "codex-linux-arm64";
  return null;
}

function findCodexExeUnder(root: string, exeFileName: string): string | null {
  // Scan up to depth 4 — codex's layout is vendor/<triple>/codex/codex(.exe)
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 4) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = joinPath(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === exeFileName.toLowerCase()) return full;
      if (e.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

function locateCodexBinary(): string | null {
  if (cachedCodexPath !== undefined) return cachedCodexPath;

  // Escape hatch: explicit env override wins over auto-discovery.
  if (process.env.CODEX_PATH && existsSync(process.env.CODEX_PATH)) {
    cachedCodexPath = process.env.CODEX_PATH;
    return cachedCodexPath;
  }

  const exeFileName = process.platform === "win32" ? "codex.exe" : "codex";
  const platformPkg = platformPackageName();
  let candidates: string[] = [];
  try {
    const cmd = process.platform === "win32" ? "where.exe codex" : "command -v codex";
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    cachedCodexPath = null;
    return null;
  }

  // First pass: any candidate that's already a real platform executable.
  for (const c of candidates) {
    if (c.toLowerCase().endsWith(process.platform === "win32" ? ".exe" : "") && existsSync(c)) {
      // Win: must end in .exe. Unix: any executable, but skip the npm shell shim.
      if (process.platform === "win32") {
        cachedCodexPath = c;
        return cachedCodexPath;
      }
    }
  }

  // Second pass: walk up from each shim looking for the platform package.
  if (platformPkg) {
    const seen = new Set<string>();
    for (const c of candidates) {
      let dir = dirname(c);
      for (let i = 0; i < 8; i++) {
        if (seen.has(dir)) break;
        seen.add(dir);
        const pkgVendor = joinPath(dir, "node_modules", "@openai", platformPkg, "vendor");
        if (existsSync(pkgVendor)) {
          const found = findCodexExeUnder(pkgVendor, exeFileName);
          if (found) {
            cachedCodexPath = found;
            return cachedCodexPath;
          }
        }
        // Also try the case where `codex` package nests its own node_modules.
        const nestedVendor = joinPath(
          dir,
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          platformPkg,
          "vendor",
        );
        if (existsSync(nestedVendor)) {
          const found = findCodexExeUnder(nestedVendor, exeFileName);
          if (found) {
            cachedCodexPath = found;
            return cachedCodexPath;
          }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }

  cachedCodexPath = null;
  return null;
}

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
const DEFAULT_CODEX_SANDBOX: SandboxMode = "danger-full-access";

/** Hard kill a codex child process AND its grandchildren.
 *
 *  `child.kill()` on Windows only TerminateProcess()'s the immediate child.
 *  The codex CLI spawns its own MCP subprocesses (our agentorch-internal
 *  stdio MCP, plus any user-registered stdio servers); those grandchildren
 *  inherit stdio handles from codex, and on Windows the OS keeps the parent
 *  pipes "open" as long as any duplicated handle is still alive somewhere
 *  in the descendant tree. That blocks the 'close' event we await after
 *  abort — manifesting as: user clicks Cancel, the agent stays in RUNNING
 *  state forever, no way to recover short of restarting Ensemble.
 *
 *  taskkill /F /T walks the whole tree by PID and SIGKILL-equivalents every
 *  process in it. On non-Windows the regular child.kill() is sufficient
 *  because POSIX signals propagate to the foreground process group (codex
 *  is spawned as session leader in a process group). */
export function killCodexChildTree(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through — process may have already exited between the check and
      // taskkill, or taskkill itself errored. Either way, try the generic
      // kill so we at least signal the immediate child.
    }
  }
  try {
    child.kill();
  } catch {
    // Already gone — race with natural exit. Nothing more to do.
  }
}

function readSandboxFromProvider(provider: { metadata?: unknown }): SandboxMode | null {
  // Provider metadata may carry defaultSandbox. Commercial default is
  // danger-full-access because current Codex CLI builds can cancel MCP tool
  // execution under stricter sandboxes even when the tool is visible.
  if (provider.metadata && typeof provider.metadata === "object") {
    const m = (provider.metadata as Record<string, unknown>).defaultSandbox;
    if (m === "read-only" || m === "workspace-write" || m === "danger-full-access") return m;
  }
  return DEFAULT_CODEX_SANDBOX;
}

function readSandboxFromAgentMetadata(agentMeta: unknown): SandboxMode | null {
  // Per-agent override (W20 Slice 5.4 — AgentSettings can set it).
  if (agentMeta && typeof agentMeta === "object") {
    const m = (agentMeta as Record<string, unknown>).sandboxMode;
    if (m === "read-only" || m === "workspace-write" || m === "danger-full-access") return m;
  }
  return null;
}

function readReasoningEffortFromAgentMetadata(agentMeta: unknown): ReasoningEffort | null {
  if (agentMeta && typeof agentMeta === "object") {
    const m = (agentMeta as Record<string, unknown>).reasoningEffort;
    if (m === "minimal" || m === "low" || m === "medium" || m === "high" || m === "xhigh") return m;
  }
  return null;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  throw new Error(`Unsupported Codex TOML value: ${String(value)}`);
}

function trustedProjectKeys(cwd?: string): string[] {
  if (!cwd) return [];
  const keys = [cwd];
  if (process.platform === "win32") keys.push(cwd.toLowerCase());
  return Array.from(new Set(keys));
}

const ENSEMBLE_OWNED_ROOT_CONFIG_KEYS = new Set([
  "approval_policy",
  "sandbox_mode",
]);

function shouldInheritCodexTable(tablePath: string): boolean {
  return tablePath === "model_providers" ||
    tablePath.startsWith("model_providers.") ||
    tablePath === "profiles" ||
    tablePath.startsWith("profiles.");
}

function extractUserCodexRuntimeConfigToml(sourceHome: string): string {
  const sourceConfig = joinPath(sourceHome, "config.toml");
  if (!existsSync(sourceConfig)) return "";

  let src: string;
  try {
    src = readFileSync(sourceConfig, "utf8");
  } catch {
    return "";
  }

  const inherited: string[] = [];
  let currentTable: string | null = null;
  let includeCurrentTable = false;
  for (const line of src.split(/\r?\n/)) {
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    const tableName = tableMatch?.[1];
    if (tableName !== undefined) {
      currentTable = tableName.trim();
      includeCurrentTable = shouldInheritCodexTable(currentTable);
      if (includeCurrentTable) inherited.push(line);
      continue;
    }

    if (currentTable === null) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const keyMatch = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
      const key = keyMatch?.[1];
      if (key === undefined) continue;
      if (ENSEMBLE_OWNED_ROOT_CONFIG_KEYS.has(key)) continue;
      inherited.push(line);
      continue;
    }

    if (includeCurrentTable) inherited.push(line);
  }

  const compact = inherited.join("\n").trim();
  return compact ? `${compact}\n\n` : "";
}

export function renderMcpConfigTomlForCodexRuntime(
  mcpServers: Record<string, Record<string, unknown>>,
  trustedProjectPaths: readonly string[] = [],
  sandboxMode?: SandboxMode | null,
  reasoningEffort?: ReasoningEffort | null,
  inheritedUserConfigToml = "",
): string {
  const lines: string[] = [
    ...(inheritedUserConfigToml.trim() ? [inheritedUserConfigToml.trimEnd(), ""] : []),
    "# Added by Ensemble for this Codex agent runtime.",
    // Ensemble drives `codex exec --json` as a non-interactive provider.
    // If Codex asks for human approval on MCP calls, the tool request is
    // cancelled instead of delivered to the peer. Keep Codex's sandbox as
    // the safety boundary, but disable per-call prompts for this isolated
    // runtime home.
    "approval_policy = \"never\"",
  ];
  // Pin sandbox_mode in config.toml as well. `codex exec resume` has a smaller
  // CLI surface than `codex exec` (no --sandbox), so historically the second
  // turn silently fell back to Codex's built-in default of read-only even when
  // the user (or provider default) selected danger-full-access. Writing the
  // value into the isolated config.toml means BOTH `exec` and `exec resume`
  // pick up the agent's chosen sandbox, with no asymmetry between turns.
  if (sandboxMode) {
    lines.push(`sandbox_mode = "${sandboxMode}"`);
  }
  if (reasoningEffort) {
    lines.push(`model_reasoning_effort = "${reasoningEffort}"`);
  }
  lines.push(
    "",
    "[features]",
    // Codex 0.132 removed the builtin_mcp feature flag; MCP loading is now
    // always on. Keep apps disabled so the runtime only exposes Ensemble MCP.
    // Codex 0.130+ also starts its remote codex_apps MCP when `apps` is true.
    // In packaged Ensemble this can fail independently of our loopback MCP
    // and prevent peer tools from reaching the model. Keep this runtime
    // focused on Ensemble-owned MCP servers.
    "apps = false",
  );
  for (const projectPath of trustedProjectPaths) {
    lines.push("", `[projects.${tomlKey(projectPath)}]`, "trust_level = \"trusted\"");
  }
  for (const [name, cfg] of Object.entries(mcpServers)) {
    lines.push("", `[mcp_servers.${tomlKey(name)}]`);
    for (const [key, value] of Object.entries(cfg)) {
      if (value === undefined || key === "env") continue;
      lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
    }
    const env = cfg.env;
    if (env && typeof env === "object" && !Array.isArray(env)) {
      lines.push("", `[mcp_servers.${tomlKey(name)}.env]`);
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        if (typeof value === "string") lines.push(`${tomlKey(key)} = ${tomlValue(value)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function prepareCodexHomeForRuntime(
  sessionId: string,
  mcpServers: Record<string, Record<string, unknown>>,
  sourceHomeOverride?: string,
  trustedProjectPath?: string,
  sandboxMode?: SandboxMode | null,
  reasoningEffort?: ReasoningEffort | null,
): string {
  // Read login state from the user's normal Codex home by default, but never
  // inherit CODEX_HOME from Ensemble's parent process. Ensemble sets CODEX_HOME
  // only for the child `codex exec` it launches; the user's standalone CLI
  // remains on its own config/auth path.
  const sourceHome = sourceHomeOverride || joinPath(homedir(), ".codex");
  const runtimeHome = joinPath(DATA_DIR, "codex-runtime", sessionId);
  mkdirSync(runtimeHome, { recursive: true });

  const sourceAuth = joinPath(sourceHome, "auth.json");
  const targetAuth = joinPath(runtimeHome, "auth.json");
  if (existsSync(sourceAuth) && sourceAuth !== targetAuth) {
    copyFileSync(sourceAuth, targetAuth);
  }

  // Keep the user's model/provider connection settings, but do not copy their
  // MCP/project/sandbox config. Ensemble owns those for this isolated runtime.
  const inheritedUserConfig = extractUserCodexRuntimeConfigToml(sourceHome);
  writeFileSync(
    joinPath(runtimeHome, "config.toml"),
    renderMcpConfigTomlForCodexRuntime(
      mcpServers,
      trustedProjectKeys(trustedProjectPath),
      sandboxMode ?? null,
      reasoningEffort ?? null,
      inheritedUserConfig,
    ),
    "utf8",
  );
  return runtimeHome;
}

export function buildCodexExecArgs(opts: {
  cwd: string;
  model?: string | null;
  promptFromStdin: boolean;
  resume?: string;
  sandbox?: SandboxMode | null;
  reasoningEffort?: ReasoningEffort | null;
}): string[] {
  const promptArg = opts.promptFromStdin ? "-" : "";
  const approvalOverride = ["-c", "approval_policy=\"never\""];
  const modelArgs = opts.model ? ["--model", opts.model] : [];
  // `codex exec resume` has a smaller CLI surface than `codex exec` — in
  // particular it does not accept --sandbox. Pass the sandbox mode through
  // the universal `-c` config override so BOTH the initial exec and any
  // subsequent resume turn pick up the same value. Without this, a resumed
  // turn silently fell back to Codex's built-in default (read-only) even
  // when the user explicitly selected danger-full-access — visible as a
  // post-first-turn permission downgrade with no UI signal.
  const sandboxOverride = opts.sandbox
    ? ["-c", `sandbox_mode="${opts.sandbox}"`]
    : [];
  const reasoningOverride = opts.reasoningEffort
    ? ["-c", `model_reasoning_effort="${opts.reasoningEffort}"`]
    : [];
  const common = [
    "--json",
    "--skip-git-repo-check",
    ...modelArgs,
    ...approvalOverride,
    ...sandboxOverride,
    ...reasoningOverride,
    "--disable",
    "apps",
    "--cd",
    opts.cwd,
    ...(opts.sandbox ? ["--sandbox", opts.sandbox] : []),
  ];
  if (opts.resume && isLikelyCodexThreadId(opts.resume)) {
    // `codex exec resume` cannot take --cd / --sandbox; rely on `-c`
    // overrides above plus spawn cwd to recreate the same execution shape.
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...modelArgs,
      ...approvalOverride,
      ...sandboxOverride,
      ...reasoningOverride,
      "--disable",
      "apps",
      opts.resume,
      promptArg,
    ].filter(Boolean);
  }
  return ["exec", ...common, promptArg].filter(Boolean);
}

export function buildCodexMcpListArgs(): string[] {
  return ["mcp", "--disable", "apps", "list"];
}

function getPackagedBlobKey(): string | undefined {
  return (globalThis as { __ENSEMBLE_BLOB_KEY?: string }).__ENSEMBLE_BLOB_KEY;
}

export function buildCodexInternalStdioServerConfig(env: Record<string, string>): Record<string, unknown> {
  const childEnv = { ...env };
  const blobKey = getPackagedBlobKey();
  if (PACKAGED && blobKey) childEnv.ENSEMBLE_BLOB_KEY = blobKey;
  if (PACKAGED) {
    return {
      command: process.execPath,
      args: ["codex-stdio-mcp"],
      env: childEnv,
    };
  }
  return {
    command: process.execPath,
    args: [
      joinPath(REPO_ROOT, "core", "node_modules", "tsx", "dist", "cli.mjs"),
      joinPath(REPO_ROOT, "core", "src", "codex-stdio-mcp.ts"),
    ],
    env: childEnv,
  };
}

function execFileText(
  file: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, cwd, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ""}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function preflightCodexMcp(opts: {
  codexPath: string;
  env: Record<string, string>;
  cwd: string;
  internalMcpServerName: string | null;
}): Promise<{ ok: true; output: string } | { ok: false; message: string; output: string }> {
  if (!opts.internalMcpServerName) return { ok: true, output: "" };
  try {
    const { stdout, stderr } = await execFileText(
      opts.codexPath,
      buildCodexMcpListArgs(),
      opts.env,
      opts.cwd,
      8000,
    );
    const output = `${stdout}\n${stderr}`.trim();
    if (output.includes(opts.internalMcpServerName)) return { ok: true, output };
    return {
      ok: false,
      output,
      message:
        `Codex CLI MCP preflight failed: ${opts.internalMcpServerName} was not visible in \`codex mcp list\`. ` +
        "peer_send/peer_query cannot be exposed to this Codex turn.",
    };
  } catch (err) {
    return {
      ok: false,
      output: "",
      message: `Codex CLI MCP preflight failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export class CodexCliRuntime implements AgentRuntime {
  async *query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent> {
    // Per-agent sandbox override > provider default > Codex CLI config/default.
    const sandbox =
      readSandboxFromAgentMetadata(opts.agentMetadata) ?? readSandboxFromProvider(opts.provider);
    const reasoningEffort = opts.reasoningEffort ?? readReasoningEffortFromAgentMetadata(opts.agentMetadata);

    // W20 Slice 5.5: register peer/ask/Task callbacks with the HTTP MCP
    // bridge keyed on this agent id so codex's MCP client can call them via
    // the loopback URL we inject below. Closure binding preserved by the
    // bridge's per-agent handler map (the same fromAgentId invariant the
    // Claude SDK side gets via per-call makePeer/AskUserMcpServer factories).
    registerHandlers(opts.sessionId, {
      peerSend: opts.peerSend,
      peerQuery: opts.peerQuery,
      askUser: opts.askUser,
      spawnTask: opts.spawnTask,
      ensembleHelp: opts.ensembleHelp,
      skillList: opts.skillList,
      skillInvoke: opts.skillInvoke,
    });

    // Build codex's mcp_servers TOML map:
    //   - agentorch-internal: HTTP MCP at the bridge URL (peer/ask/Task)
    //   - user-registered external MCP rows, translated from Claude shape
    const mcpServersForCodex: Record<string, Record<string, unknown>> = {
      ...mcpServersToCodexConfig(opts.mcpServers as unknown as Record<string, unknown>),
    };
    // Use a local stdio MCP process for Codex's model-facing tool discovery.
    // The stdio process proxies tool calls back to Ensemble core over a narrow
    // bearer-auth loopback endpoint. Real smoke testing showed Codex 0.130 can
    // list an HTTP MCP server in config but still not expose it in `exec`.
    const bridgeBaseUrl = getBridgeBaseUrl();
    const internalMcpServerName = `agentorch-internal-${opts.sessionId.slice(0, 8)}`;
    const wantsBridge =
      opts.peerSend ||
      opts.peerQuery ||
      opts.askUser ||
      opts.spawnTask ||
      opts.ensembleHelp ||
      opts.skillList ||
      opts.skillInvoke;
    if (bridgeBaseUrl && wantsBridge) {
      mcpServersForCodex[internalMcpServerName] = buildCodexInternalStdioServerConfig({
        ENSEMBLE_MCP_BASE_URL: bridgeBaseUrl,
        ENSEMBLE_MCP_AGENT_ID: opts.sessionId,
        ENSEMBLE_MCP_BEARER: BRIDGE_TOKEN,
      });
    }
    // Suppress unused-import warning if we ever stop using legacy URL.
    void getBridgeUrl;

    // codex exec mode (the SDK uses non-interactive mode) refuses to run
    // outside a git repo unless this is set. Our agents' cwd is the user's
    // Ensemble data dir by default, which is not usually a git repo — without
    // this Codex refuses non-repo turns. sandboxMode is the real safety
    // gate; the git-repo check is a UX nudge for change-tracking, not a
    // security boundary, so it's safe to bypass.
    // No apiKey → codex SDK + CLI fall through to ~/.codex/auth.json. If
    // auth.json is missing the codex CLI will surface an error which we
    // pass through as a runtime event.
    const codexPath = opts.codexCliPath ?? await getCodexCliPath() ?? locateCodexBinary();
    if (!codexPath) {
      yield {
        type: "error",
        message:
          "codex CLI not found on PATH. Install it with `npm i -g @openai/codex` (or download from openai.com), then run `codex login`.",
      };
      unregisterHandlers(opts.sessionId);
      return;
    }
    // Bearer token for the agentorch-internal MCP server (when present).
    // codex reads this env var as configured by `bearer_token_env_var` above.
    //
    // CRITICAL: the codex SDK treats a non-empty `env` option as the COMPLETE
    // child env (it does NOT merge with process.env — see
    // node_modules/@openai/codex-sdk/dist/index.js: if(envOverride) skips the
    // process.env passthrough). So if we hand it `{ ENSEMBLE_MCP_BEARER: ... }`
    // alone, the codex child spawns without PATH / USERPROFILE / APPDATA —
    // which breaks auth.json discovery, the streamable-HTTP MCP HTTP client's
    // connection setup (proxy env, cert store), and skill resolution. That
    // surfaces as: agentorch-internal "registered" via --config (codex mcp list
    // shows it) but its MCP initialize handshake never completes, so the
    // model never sees peer_send/peer_query.
    //
    // Always seed from process.env. SessionManager's opts.env / providerEnv
    // layer on top so explicit overrides still win.
    const codexEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") codexEnv[k] = v;
    }
    Object.assign(codexEnv, opts.env ?? {});
    if (bridgeBaseUrl && wantsBridge) codexEnv.ENSEMBLE_MCP_BEARER = BRIDGE_TOKEN;
    let codexHome: string | null = null;
    if (Object.keys(mcpServersForCodex).length > 0) {
      // Pass the resolved sandbox so it lands in config.toml as well. The CLI
      // -c override already covers exec + resume (see buildCodexExecArgs), but
      // a config-level value is the durable safety net should anyone ever
      // invoke codex against this CODEX_HOME without our flags.
      codexHome = prepareCodexHomeForRuntime(
        opts.sessionId,
        mcpServersForCodex,
        undefined,
        opts.cwd,
        sandbox,
        reasoningEffort,
      );
      codexEnv.CODEX_HOME = codexHome;
    }
    const canResumeNative = isLikelyCodexThreadId(opts.resume);
    const preflight = await preflightCodexMcp({
      codexPath,
      env: codexEnv,
      cwd: opts.cwd,
      internalMcpServerName: bridgeBaseUrl && wantsBridge ? internalMcpServerName : null,
    });
    if (!preflight.ok) {
      yield { type: "error", message: preflight.message };
      unregisterHandlers(opts.sessionId);
      return;
    }
    const cliArgs = buildCodexExecArgs({
      cwd: opts.cwd,
      model: opts.model,
      promptFromStdin: true,
      resume: canResumeNative ? opts.resume : undefined,
      sandbox,
      reasoningEffort,
    });
    let codexSessionId = canResumeNative ? opts.resume! : randomUUID();

    // Diagnostic for the recurring "codex provider can't see peer_send" bug.
    // Logs the exact CLI invocation shape plus which URL we expect codex to
    // call back to. Pair with mcp-bridge's per-request log to see whether
    // codex is skipping, failing, or successfully invoking the internal MCP.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        codexRuntime: true,
        directCli: true,
        sessionId: opts.sessionId,
        codexPath,
        cliArgs,
        bridgeBaseUrl,
        codexHome,
        stdioProxyEnvSet: !!codexEnv.ENSEMBLE_MCP_BEARER,
        mcpServerKeys: Object.keys(mcpServersForCodex),
        preflightOutputHead: preflight.output.slice(0, 500),
      }),
    );

    let accumulatedText = "";
    let lastUsage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number } | null = null;

    try {
      const input = canResumeNative ? opts.prompt : buildPromptWithHistory(opts);
      const child = spawn(codexPath, cliArgs, {
        cwd: opts.cwd,
        env: codexEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stderrChunks: string[] = [];
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
        opts.onStderr?.(chunk);
      });
      const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const onAbort = () => {
        // Hard-kill the entire codex process tree. See killCodexChildTree
        // for why a plain child.kill() can leave Windows pipes pinned by
        // grandchild MCP processes and hang the await closePromise below.
        killCodexChildTree(child);
      };
      opts.abortController.signal.addEventListener("abort", onAbort, { once: true });
      child.stdin.end(input, "utf8");

      yield {
        type: "sdk_message",
        payload: {
          type: "system",
          subtype: "init",
          session_id: codexSessionId,
          model: opts.model,
        },
      };

      const lines = createInterface({ input: child.stdout });
      for await (const line of lines) {
        if (opts.abortController.signal.aborted) break;
        const trimmed = String(line).trim();
        if (!trimmed) continue;
        let ev: unknown;
        try {
          ev = JSON.parse(trimmed);
        } catch {
          opts.onStderr?.(`[codex-json] non-JSON stdout: ${trimmed}\n`);
          continue;
        }
        if (isRecord(ev) && ev.type === "thread.started" && typeof ev.thread_id === "string") {
          codexSessionId = ev.thread_id;
          continue;
        }
        const out = translateEvent(ev, codexSessionId, opts.model);
        if (out.streamEvent) {
          // Emit as stream_event for streaming UX (frontend already
          // handles content_block_delta + text_delta from W17 work).
          yield { type: "sdk_message", payload: out.streamEvent as SdkMessage };
          if (out.deltaText) accumulatedText += out.deltaText;
        }
        if (out.assistantMessage) {
          yield { type: "sdk_message", payload: out.assistantMessage as SdkMessage };
        }
        if (out.usage) lastUsage = out.usage;
        if (out.errorMessage) {
          yield { type: "error", message: out.errorMessage };
          return;
        }
      }
      opts.abortController.signal.removeEventListener("abort", onAbort);
      // Race the close event against a deadline. If we killed the child
      // (abort path) and the 'close' event still hasn't fired after 5s,
      // give up waiting — the OS will reap the zombie eventually but we
      // can't let the generator hang and prevent SessionManager from
      // observing the run's end. Without this race a wedged grandchild
      // pinning a stdio pipe would leave sendMessage suspended on this
      // await forever (the original aivision-stuck bug).
      const close = await Promise.race<{ code: number | null; signal: NodeJS.Signals | null } | "timeout">([
        closePromise,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
      ]);
      if (close === "timeout") {
        console.warn(
          `[codex] close event did not fire within 5s after kill (sessionId=${opts.sessionId.slice(0, 8)}); proceeding anyway`,
        );
      } else if (!opts.abortController.signal.aborted && close.code !== 0) {
        const stderr = stderrChunks.join("").trim();
        yield {
          type: "error",
          message: `codex exec exited with code ${close.code}${close.signal ? ` (${close.signal})` : ""}${stderr ? `\n${stderr}` : ""}`,
        };
        return;
      }

      // Synthesize a Claude-shaped `result` with modelUsage so the W17
      // double-write hook in SessionManager picks it up uniformly. The
      // billingModel='subscription' + costUSD=0 logic lives at the
      // UsageEvent insertion site keyed on provider.kind === 'openai-codex'
      // (W20 Slice 5.6). Tokens here are populated from codex's Usage.
      const modelUsage = lastUsage
        ? {
            [opts.model || "codex"]: {
              inputTokens: lastUsage.input_tokens,
              outputTokens: lastUsage.output_tokens + lastUsage.reasoning_output_tokens,
              cacheReadInputTokens: lastUsage.cached_input_tokens,
              cacheCreationInputTokens: 0,
              costUSD: 0,
              webSearchRequests: 0,
              contextWindow: 0,
            },
          }
        : {};
      yield {
        type: "sdk_message",
        payload: {
          type: "result",
          subtype: "success",
          session_id: codexSessionId,
          modelUsage,
        },
      };
    } catch (err) {
      if (opts.abortController.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: msg };
    } finally {
      // Tear down bridge handler entry so a later turn for a different
      // agent can't accidentally inherit this agent's closures.
      unregisterHandlers(opts.sessionId);
    }
  }
}

function isLikelyCodexThreadId(id: string | undefined): id is string {
  if (!id) return false;
  // Codex CLI session ids are currently UUIDv7. Older Ensemble builds stored a
  // synthetic UUIDv4 here, which cannot be resumed via `codex exec resume`.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function buildPromptWithHistory(opts: RuntimeOptions): string {
  const turns: string[] = [];
  if (opts.systemPrompt) turns.push(`System instructions:\n${opts.systemPrompt}`);
  for (const m of opts.history) {
    if (m.type === "user") {
      const text = extractUserText(m);
      if (text) turns.push(`User:\n${text}`);
    } else if (m.type === "assistant") {
      const text = extractAssistantText(m);
      if (text) turns.push(`Assistant:\n${text}`);
    }
  }
  if (turns.length === 0) return opts.prompt;
  turns.push(`User:\n${opts.prompt}`);
  return [
    "Continue this Ensemble pane conversation. The transcript below is reconstructed from the local pane history because no native Codex thread id was available.",
    "",
    turns.join("\n\n---\n\n"),
  ].join("\n");
}

function extractUserText(msg: { message?: unknown }): string {
  const m = msg.message as { content?: unknown } | undefined;
  return typeof m?.content === "string" ? m.content : "";
}

function extractAssistantText(msg: { message?: unknown }): string {
  const blocks = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface TranslateOut {
  streamEvent?: Record<string, unknown>;
  deltaText?: string;
  assistantMessage?: Record<string, unknown>;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number } | null;
  errorMessage?: string;
}

function normalizeUsage(value: unknown): TranslateOut["usage"] {
  if (!isRecord(value)) return null;
  const n = (key: string) => (typeof value[key] === "number" ? value[key] : 0);
  return {
    input_tokens: n("input_tokens"),
    cached_input_tokens: n("cached_input_tokens"),
    output_tokens: n("output_tokens"),
    reasoning_output_tokens: n("reasoning_output_tokens"),
  };
}

function errorMessageFromUnknown(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function translateAgentMessageEvent(ev: Record<string, unknown>, synthSessionId: string): TranslateOut {
  const text =
    typeof ev.text === "string"
      ? ev.text
      : isRecord(ev.message) && typeof ev.message.content === "string"
        ? ev.message.content
        : "";
  if (!text) return {};
  return {
    deltaText: text,
    streamEvent: {
      type: "stream_event",
      session_id: synthSessionId,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    },
    assistantMessage: {
      type: "assistant",
      session_id: synthSessionId,
      message: { content: [{ type: "text" as const, text }] },
    },
  };
}

function translateEvent(
  ev: unknown,
  synthSessionId: string,
  modelName: string,
): TranslateOut {
  if (!isRecord(ev)) return {};
  switch (ev.type) {
    case "thread.started":
      // We already emitted system/init; thread_id is informational. No-op.
      return {};
    case "turn.started":
      return {};
    case "turn.completed":
      return { usage: normalizeUsage(ev.usage) };
    case "turn.failed":
      return { errorMessage: errorMessageFromUnknown(ev.error) };
    case "error":
      return { errorMessage: typeof ev.message === "string" ? ev.message : JSON.stringify(ev) };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return translateItem(ev.item, synthSessionId, modelName, ev.type === "item.completed");
    case "agent_message":
    case "assistant_message":
      return translateAgentMessageEvent(ev, synthSessionId);
    default:
      // SDK may grow event types; we don't crash on unknown.
      return {};
  }
}

function translateItem(
  item: unknown,
  synthSessionId: string,
  modelName: string,
  isCompleted: boolean,
): TranslateOut {
  if (!isRecord(item)) return {};
  if (item.type === "agent_message") {
    // codex emits the full message text in one item per turn. To keep the
    // frontend's incremental-text UX, send it as a stream_event delta on
    // completion (no inter-token streaming from codex SDK currently). If
    // future SDK versions add token-level streaming, swap to item.updated
    // diffing.
    const text = typeof item.text === "string" ? item.text : "";
    if (isCompleted && text) {
      return {
        deltaText: text,
        streamEvent: {
          type: "stream_event",
          session_id: synthSessionId,
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        },
        assistantMessage: {
          type: "assistant",
          session_id: synthSessionId,
          message: { content: [{ type: "text" as const, text }] },
        },
      };
    }
    return {};
  }
  if (item.type === "command_execution" && isCompleted) {
    // Surface bash-equivalent tool execution as an assistant tool_use block
    // so the frontend's ToolCard renders it. Mirroring how claude SDK
    // surfaces Bash invocations.
    return {
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: {
          content: [
            {
              type: "tool_use",
              id: typeof item.id === "string" ? item.id : randomUUID(),
              name: "Bash",
              input: { command: typeof item.command === "string" ? item.command : "" },
            },
          ],
        },
      },
    };
  }
  if (item.type === "file_change" && isCompleted) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const summary = changes
      .map((c) => (isRecord(c) ? `${String(c.kind ?? "change")} ${String(c.path ?? "")}` : "change"))
      .join(", ");
    return {
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: {
          content: [
            {
              type: "tool_use",
              id: typeof item.id === "string" ? item.id : randomUUID(),
              name: "Edit",
              input: { summary, changes, status: item.status },
            },
          ],
        },
      },
    };
  }
  if (item.type === "mcp_tool_call" && isCompleted) {
    const server = typeof item.server === "string" ? item.server : "unknown";
    const tool = typeof item.tool === "string" ? item.tool : "unknown";
    return {
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: {
          content: [
            {
              type: "tool_use",
              id: typeof item.id === "string" ? item.id : randomUUID(),
              name: `mcp__${server}__${tool}`,
              input: item.arguments,
            },
          ],
        },
      },
    };
  }
  if (item.type === "web_search" && isCompleted) {
    return {
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: {
          content: [
            {
              type: "tool_use",
              id: typeof item.id === "string" ? item.id : randomUUID(),
              name: "WebSearch",
              input: { query: typeof item.query === "string" ? item.query : "" },
            },
          ],
        },
      },
    };
  }
  if (item.type === "reasoning" && isCompleted) {
    // Reasoning is codex's internal thinking summary. Show as a faint
    // assistant text block so the user has visibility but it's clearly
    // distinct from the agent_message reply. v1 simple: prefix with
    // "[reasoning]" so the frontend doesn't need a new block type.
    const text = typeof item.text === "string" ? item.text : "";
    return {
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: { content: [{ type: "text" as const, text: `[reasoning] ${text}` }] },
      },
    };
  }
  if (item.type === "error" && isCompleted) {
    return { errorMessage: typeof item.message === "string" ? item.message : JSON.stringify(item) };
  }
  // todo_list and other items: not surfacing in v1; future enhancement.
  void modelName;
  return {};
}
