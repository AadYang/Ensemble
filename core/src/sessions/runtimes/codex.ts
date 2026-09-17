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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import type { SdkMessage } from "@agentorch/shared";
import { isReasoningToken, REASONING_SYNTAX_RULE } from "@agentorch/shared";
import type { LivenessProbeKind } from "@agentorch/shared";
import type { AgentRuntime, RuntimeErrorEvent, RuntimeEvent, RuntimeOptions } from "./types.js";

/** The answer a Codex health check gives, from what this process can see.
 *
 *  While the child lives the run is alive. Once the OS says the child is gone,
 *  the answer depends on whether the turn had already reached its own terminal
 *  result: an exit that ends a completed turn is NOT evidence of death, and this
 *  probe says `unknown` rather than pretending it is. Only an exit in the middle
 *  of a turn, with the process no longer there to finish it, is `dead`.
 *
 *  Exported so the phase-4 gate can prove the wiring and the answers instead of
 *  reading the source: a private closure inside the runtime is untestable
 *  without launching a real codex CLI. */
export function codexChildProbe(state: { exited: boolean; turnCompleted: boolean }): LivenessProbeKind {
  if (!state.exited) return "alive";
  return state.turnCompleted ? "unknown" : "dead";
}
import {
  codexUsageSnapshotToDelta,
  normalizeCodexUsageSnapshot,
  readCodexTurnContext,
  readCodexUsageSnapshot,
  type CodexUsageSnapshot,
} from "./codex-usage.js";
import { fileMark, sessionFileMark } from "../../capability/marks.js";
import { markCoversPath } from "../../capability/run-plan.js";
import type { ArtifactMark } from "../../capability/types.js";
import {
  getBridgeBaseUrl,
  getBridgeUrl,
  BRIDGE_TOKEN,
  mcpServersToCodexConfig,
  registerHandlers,
  unregisterHandlers,
} from "../../mcp-bridge.js";
import { CLI_INSTALL_INFO, getCodexCliPath } from "../../cli-config.js";
import {
  requestedRuntimeWindow,
  vendorScopeForModel,
  type WindowScope,
} from "../../context-window.js";

/** This runtime's scope for a model. `runtimeVersion` is left null: the policy
 *  gate does not consult it, and any compaction observation needs a version we
 *  do not have here — so an unmatched observation stays unused instead of being
 *  borrowed from another build. */
function codexScopeFor(model: string | null | undefined): WindowScope {
  return { runtime: "codex", vendor: vendorScopeForModel(model), runtimeVersion: null };
}
import { DATA_DIR, PACKAGED, REPO_ROOT } from "../../paths.js";
import { reloadSkills } from "../../skills/index.js";

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

/** The reasoning level is interpolated into `config.toml` (`key = "value"`) and
 *  into `-c key="value"` argv, so it has to BE a token before it gets there: a
 *  quote, a space or a newline would stop being a value and start being config
 *  syntax. The runtime checks the plan value before it launches anything (see
 *  `query`), which is where a bad value produces a structured error; this is the
 *  same check at the interpolation point, so no other caller of these exported
 *  renderers can interpolate something unvalidated. */
function assertReasoningToken(value: string): string {
  if (!isReasoningToken(value)) {
    throw new Error(
      `refusing to write an unsafe reasoning level into Codex config (${REASONING_SYNTAX_RULE}): ${JSON.stringify(value)}`,
    );
  }
  return value;
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

function stripRootConfigKeysFromToml(toml: string, keys: ReadonlySet<string>): string {
  if (toml.trim() === "" || keys.size === 0) return toml;
  const lines: string[] = [];
  let currentTable: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    const tableName = tableMatch?.[1];
    if (tableName !== undefined) {
      currentTable = tableName.trim();
      lines.push(line);
      continue;
    }
    if (currentTable === null) {
      const keyMatch = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
      const key = keyMatch?.[1];
      if (key !== undefined && keys.has(key)) continue;
    }
    lines.push(line);
  }
  const compact = lines.join("\n").trim();
  return compact ? `${compact}\n\n` : "";
}

export function renderMcpConfigTomlForCodexRuntime(
  mcpServers: Record<string, Record<string, unknown>>,
  trustedProjectPaths: readonly string[] = [],
  sandboxMode?: SandboxMode | null,
  /** An open level token from the plan (see shared/src/reasoning.ts), not a
   *  closed enum: Codex's own ladder (`ultra`, and whatever a future CLI adds)
   *  is not ours to enumerate, and the model capability registry is what decides
   *  whether a value is allowed. */
  reasoningEffort?: string | null,
  inheritedUserConfigToml = "",
  contextWindow?: number | null,
): string {
  const overriddenRootKeys = new Set<string>();
  if (reasoningEffort) overriddenRootKeys.add("model_reasoning_effort");
  if (contextWindow) overriddenRootKeys.add("model_context_window");
  const safeInheritedUserConfigToml = stripRootConfigKeysFromToml(
    inheritedUserConfigToml,
    overriddenRootKeys,
  );
  const lines: string[] = [
    ...(safeInheritedUserConfigToml.trim() ? [safeInheritedUserConfigToml.trimEnd(), ""] : []),
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
    lines.push(`model_reasoning_effort = "${assertReasoningToken(reasoningEffort)}"`);
  }
  // Declare the model's documented CAPACITY (claude.ts declares the same thing
  // through CLAUDE_CODE_MAX_CONTEXT_TOKENS). Codex otherwise uses its own
  // model-table default — for gpt-5.6-sol that is context_window 272,000, so it
  // compacted at 258,400 (95%) while the model is documented at 1.05M.
  //
  // This is a REQUEST, not the effective window. Measured with the installed CLI
  // 0.154.0: a bigger value lifts the effective window to 95% of the backend's
  // max_context_window (872,000 → 828,400 for this model) and anything above
  // that is clamped silently, not rejected. So the value written here must never
  // be shown as available headroom — the bar uses the OBSERVED effective window
  // (context-window.ts RUNTIME_WINDOW_PROFILES / effectiveWindow). Values come
  // only from `confirmed` catalog entries via the policy gate.
  if (contextWindow) {
    lines.push(`model_context_window = ${contextWindow}`);
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
  /** REQUIRED, and deliberately not optional: this used to be the trailing
   *  optional parameter and the only production caller omitted it, so
   *  `requestedRuntimeWindow("")` returned null and `model_context_window` was
   *  silently never written — the config.toml "durable safety net" did not
   *  exist and nothing failed. As a required parameter TypeScript catches a
   *  dropped argument at the call site instead of shipping a no-op. */
  model: string | null,
  sourceHomeOverride?: string,
  trustedProjectPath?: string,
  sandboxMode?: SandboxMode | null,
  reasoningEffort?: string | null,
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
      requestedRuntimeWindow(model ?? "", codexScopeFor(model)),
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
  reasoningEffort?: string | null;
  contextWindow?: number | null;
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
    ? ["-c", `model_reasoning_effort="${assertReasoningToken(opts.reasoningEffort)}"`]
    : [];
  // Request the documented context window (see context-window.ts). Codex's own
  // model table defaults gpt-5.6-sol to 272,000 and compacts at 95% of that
  // (258,400) even though the model is documented at 1.05M. `-c` is the only
  // channel that always applies: it works on `exec` AND `exec resume`, whereas
  // the isolated CODEX_HOME (which also pins it in config.toml now that the
  // model is passed through) is only created when the agent has MCP servers.
  // The CLI clamps silently to the backend's max (95% of 872,000 = 828,400 on
  // CLI 0.154.0) rather than erroring, so treat this as a request only.
  const contextWindowOverride = opts.contextWindow
    ? ["-c", `model_context_window=${opts.contextWindow}`]
    : [];
  const common = [
    "--json",
    "--skip-git-repo-check",
    ...modelArgs,
    ...approvalOverride,
    ...sandboxOverride,
    ...reasoningOverride,
    ...contextWindowOverride,
    "--disable",
    "apps",
    // The turn's project root, from the plan. `--cd` and the spawn cwd are the
    // two channels Codex resolves paths through; both take the same value.
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
      ...contextWindowOverride,
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
        "peer_send/peer_query/conversation_search cannot be exposed to this Codex turn.",
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
    // From the plan, never re-derived: the value `/status` reports and the value
    // written into config.toml / argv are the same field of the same snapshot.
    // `undefined` is `inherit` — no `model_reasoning_effort` is written at all,
    // so Codex applies its own default for the model.
    const reasoningEffort = opts.runPlan.execution.reasoningEffort ?? null;
    if (reasoningEffort !== null && !isReasoningToken(reasoningEffort)) {
      // Codex would take this value straight into config.toml and argv. Refuse
      // before spawning, and refuse to quietly run without it — Codex passes any
      // level its models accept, so an unrepresentable value is a bug upstream
      // of here, not a reason to drop the user's setting.
      yield {
        type: "error",
        code: "REASONING_EFFORT_UNSUPPORTED",
        message: `reasoning level ${JSON.stringify(reasoningEffort)} is not a safe token (${REASONING_SYNTAX_RULE}) and cannot be passed to the Codex CLI`,
        recoverable: false,
        reasoning: {
          requested: String(reasoningEffort),
          runtime: opts.runPlan.identity.runtime,
          model: opts.runPlan.identity.modelId,
          // Codex forwards any safe token, so the only thing it cannot express is
          // an unsafe one; the empty list says that without pretending to know
          // which levels the model has.
          supportedLevels: [],
          source: "Codex CLI runtime forwards any syntactically safe level token to the CLI; the level itself is the model's, not the adapter's",
        },
      };
      return;
    }
    // The turn's working directory, from the plan: `--cd` on a new turn, the
    // spawned process's cwd on every turn (including `exec resume`, which does
    // not accept `--cd`), and the MCP preflight's cwd. `CODEX_DEFAULT_CWD` and
    // the agent's home directory are gone: a turn that has not been told where
    // to work has nowhere to work, and guessing is how an agent ends up editing
    // files in the sidecar's directory.
    const cwd = opts.runPlan.execution.projectRoot.value;
    if (cwd === null) {
      yield {
        type: "error",
        code: "PROJECT_ROOT_NOT_FOUND",
        message: `no working directory for this turn: ${opts.runPlan.execution.projectRoot.invalid?.reason ?? "the plan carries no project root"}`,
        recoverable: false,
      };
      unregisterHandlers(opts.sessionId);
      return;
    }

    // W20 Slice 5.5: register peer/ask/Task callbacks with the HTTP MCP
    // bridge keyed on this agent id so codex's MCP client can call them via
    // the loopback URL we inject below. Closure binding preserved by the
    // bridge's per-agent handler map (the same fromAgentId invariant the
    // Claude SDK side gets via per-call makePeer/AskUserMcpServer factories).
    registerHandlers(opts.sessionId, {
      peerSend: opts.peerSend,
      peerQuery: opts.peerQuery,
      conversationSearch: opts.conversationSearch,
      askUser: opts.askUser,
      spawnTask: opts.spawnTask,
      ensembleHelp: opts.ensembleHelp,
      skillList: opts.skillList,
      skillInvoke: opts.skillInvoke,
      artifactRead: opts.artifactRead,
      artifactSearch: opts.artifactSearch,
      // Codex's own shell tool has the same ownership defect the job primitive
      // removes, so the bridge must carry the fix — otherwise the one runtime
      // a long build is most likely to be launched from is the one without it.
      jobs: opts.jobs,
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
      opts.conversationSearch ||
      opts.askUser ||
      opts.spawnTask ||
      opts.ensembleHelp ||
      opts.skillList ||
      opts.skillInvoke ||
      opts.artifactRead ||
      opts.artifactSearch ||
      opts.jobs;
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
          `codex CLI not found on PATH. Install it with \`${CLI_INSTALL_INFO.codex.recommendedInstallCommand}\`, then run \`${CLI_INSTALL_INFO.codex.loginCommand}\`.`,
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
    // model never sees peer_send/peer_query/conversation_search.
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
        // The model decides the declared window; omitting it silently disabled
        // the config.toml safety net (see the parameter doc).
        opts.model,
        undefined,
        cwd,
        sandbox,
        reasoningEffort,
      );
      codexEnv.CODEX_HOME = codexHome;
      reloadSkills();
    }
    const canResumeNative = isLikelyCodexThreadId(opts.resume);
    const preflight = await preflightCodexMcp({
      codexPath,
      env: codexEnv,
      cwd,
      internalMcpServerName: bridgeBaseUrl && wantsBridge ? internalMcpServerName : null,
    });
    if (!preflight.ok) {
      yield { type: "error", message: preflight.message };
      unregisterHandlers(opts.sessionId);
      return;
    }
    const cliArgs = buildCodexExecArgs({
      cwd,
      model: opts.model,
      promptFromStdin: true,
      resume: canResumeNative ? opts.resume : undefined,
      sandbox,
      reasoningEffort,
      // The CAPACITY declaration passed the planner's policy gate. The display-only
      // advertised value and the observed effective clamp are deliberately
      // not consulted here.
      contextWindow: opts.runPlan.context.requestedRuntimeWindow,
    });
    let codexSessionId = canResumeNative ? opts.resume! : randomUUID();
    const resumeSessionFile = canResumeNative
      ? findCodexSessionFile(codexHome ?? joinPath(homedir(), ".codex"), opts.resume)
      : null;
    // What this turn's rollout looked like BEFORE the turn started.
    //
    //   resume      — the file is on disk, so the mark is that exact path plus
    //                 its byte length (the size the reading has to beat).
    //   fresh thread— the file does not exist yet and its name carries a thread
    //                 id we only learn from `thread.started`; the mark is written
    //                 there, naming the sessions directory and the session.
    //
    // Without this, a turn that dies before its first model request appends
    // nothing to the rollout, and the newest `token_count` in it is the PREVIOUS
    // turn's — an event with no turn id to check, so only the pre-turn size can
    // reject it.
    let turnMarks: ArtifactMark[] = resumeSessionFile
      ? [fileMark(resumeSessionFile)].filter((m): m is ArtifactMark => m !== null)
      : [];
    const codexSessionsDir = joinPath(codexHome ?? joinPath(homedir(), ".codex"), "sessions");

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
        model: opts.model,
        reasoningEffort,
        sandbox,
        cwd,
        resume: canResumeNative ? opts.resume : null,
        resumeSessionFileExists: resumeSessionFile !== null,
        resumeSessionFile,
        bridgeBaseUrl,
        codexHome,
        stdioProxyEnvSet: !!codexEnv.ENSEMBLE_MCP_BEARER,
        mcpServerKeys: Object.keys(mcpServersForCodex),
        preflightOutputHead: preflight.output.slice(0, 500),
      }),
    );

    let accumulatedText = "";
    let lastUsage: CodexUsageSnapshot | null = null;
    let turnStarted = false;
    let turnCompleted = false;

    // Hoisted so the `finally` can guarantee the codex process tree is dead on
    // EVERY exit path (normal, error, early-return, abort, close-timeout, or
    // consumer abandoning the generator). A lingering codex process keeps the
    // thread-store writer lock held, so the next `codex exec resume` on the
    // same thread fails with "already has an active writer" — the exact
    // decoupling reported when the window shows "interrupted" but a subprocess
    // is still alive.
    let childForCleanup: ChildProcess | null = null;
    // Phase 4 liveness. `exited` is the raw observation from the OS; whether it
    // is EVIDENCE of death is decided elsewhere. The runtime's only job here is
    // to report it at a moment when it can also say whether the exit was the
    // end of a completed turn (which is not evidence) or a process that vanished
    // mid-turn (which is).
    let childExited = false;
    let reportedError = false;
    try {
      const input = canResumeNative ? buildCurrentTurnPrompt(opts.prompt) : buildPromptWithHistory(opts);
      const child = spawn(codexPath, cliArgs, {
        cwd,
        env: codexEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      childForCleanup = child;
      // The handle we are holding right now is what makes this route
      // observable at all: "codex has printed nothing for seven minutes" used to
      // be indistinguishable from "codex is gone", and the difference is the
      // entire point of the phase-4 rule.
      opts.liveness?.childProcessStarted({ pid: child.pid ?? null });
      child.once("exit", () => {
        childExited = true;
      });
      child.once("error", () => {
        childExited = true;
      });
      // Registered BEFORE the loop so a health check during the turn gets a
      // real answer. While the child lives it is `alive`; once it is gone the
      // answer depends on whether the turn had already completed — an exit that
      // ends a completed turn is not evidence, and this probe refuses to
      // pretend it is by answering `unknown`.
      opts.liveness?.registerProbe?.(() => codexChildProbe({ exited: childExited, turnCompleted }));
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
          // A fresh thread's rollout is named after the id we just learned, so
          // this is the first moment its mark CAN be written.
          if (turnMarks.length === 0) {
            const mark = sessionFileMark(codexSessionsDir, ev.thread_id);
            if (mark) turnMarks = [mark];
          }
          continue;
        }
        if (isRecord(ev) && (ev.type === "turn.started" || ev.type === "turn.failed")) turnStarted = true;
        if (isRecord(ev) && ev.type === "turn.completed") turnCompleted = true;
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
          reportedError = true;
          yield buildCodexRuntimeErrorEvent(out.errorMessage, {
            usedNativeResume: canResumeNative,
            turnStarted,
            turnCompleted,
          });
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
        reportedError = true;
        yield buildCodexRuntimeErrorEvent(
          `codex exec exited with code ${close.code}${close.signal ? ` (${close.signal})` : ""}${stderr ? `\n${stderr}` : ""}`,
          {
            usedNativeResume: canResumeNative,
            turnStarted,
            turnCompleted,
          },
        );
        return;
      }
      if (!opts.abortController.signal.aborted && turnStarted && !turnCompleted) {
        reportedError = true;
        yield buildCodexRuntimeErrorEvent("codex turn ended before turn.completed", {
          usedNativeResume: canResumeNative,
          turnStarted,
          turnCompleted,
        });
        return;
      }

      // Synthesize a Claude-shaped `result` with modelUsage so the W17
      // double-write hook in SessionManager picks it up uniformly. The
      // billingModel='subscription' + costUSD=0 logic lives at the
      // UsageEvent insertion site keyed on provider.kind === 'openai-codex'
      // (W20 Slice 5.6). Tokens here are populated from codex's Usage.
      const usageDelta = lastUsage
        ? codexUsageSnapshotToDelta(lastUsage, readCodexUsageSnapshot(opts.agentMetadata))
        : null;
      // The rollout file is named after the thread id, which for a FRESH thread
      // only exists once `thread.started` arrived — so it is located here, after
      // the turn, rather than with the resume preflight far above.
      const rolloutPath =
        findCodexSessionFile(codexHome ?? joinPath(homedir(), ".codex"), codexSessionId) ?? "";
      const turnContext = rolloutReadingBelongsToThisTurn(rolloutPath, turnMarks)
        ? readCodexTurnContext(rolloutPath)
        : null;
      // `contextWindow` here is the window the BACKEND declared for this very
      // session — the number codex is actually enforcing, including any clamp
      // of what we asked for. It is published on modelUsage so the bar gets it
      // through the one shared reader (reportedContextWindowFromResult) as a
      // SESSION OBSERVATION, which outranks the static runtime profile. Leaving
      // it at 0 (as this used to) threw away the only per-session evidence we
      // have and left the bar dependent on a profile pinned to one CLI version.
      const modelKey = opts.model || "codex";
      const sessionContextWindow = turnContext?.contextWindow ?? 0;
      const modelUsage = usageDelta
        ? {
            [modelKey]: {
              inputTokens: usageDelta.regularInputTokens,
              outputTokens: usageDelta.outputTokens,
              cacheReadInputTokens: usageDelta.cacheReadInputTokens,
              cacheCreationInputTokens: usageDelta.cacheCreationInputTokens,
              costUSD: 0,
              webSearchRequests: 0,
              contextWindow: sessionContextWindow,
            },
          }
        : sessionContextWindow > 0
          ? // No usage delta (e.g. an aborted turn) but the rollout still told
            // us the window. Carry it so the bar is not blinded; the usage
            // extractor skips all-zero rows, so this cannot fabricate billing.
            { [modelKey]: { contextWindow: sessionContextWindow } }
          : {};
      yield {
        type: "sdk_message",
        payload: {
          type: "result",
          subtype: "success",
          session_id: codexSessionId,
          modelUsage,
          ...(lastUsage ? { _codexUsageSnapshot: lastUsage } : {}),
          // Context-bar input: unlike `lastUsage` above (a cumulative thread
          // total), the rollout's newest `token_count` event holds the size of
          // the LAST model request. Emitted in the same `contextUsage` shape the
          // OpenAI runtime uses so SessionManager needs one reader for both,
          // keeping that runtime's convention (inputTokens excludes the cached
          // prefix) so the shared reader's sum is the true prompt size.
          //
          // The event's `model_context_window` IS the denominator for this
          // session: it is published on `modelUsage[model].contextWindow` above
          // and read back via `reportedContextWindowFromResult`, where it
          // outranks any static profile. That is what makes a silent backend
          // clamp visible — we ask for 1,050,000, the backend enforces 828,400,
          // and the bar follows the enforced number rather than the request.
          // The requested value only ever travels to the CLI (config.toml /
          // `-c model_context_window=`), never to the bar.
          ...(turnContext
            ? {
                contextUsage: {
                  model: opts.model,
                  inputTokens: Math.max(0, turnContext.promptTokens - turnContext.cachedInputTokens),
                  outputTokens: 0,
                  cacheReadInputTokens: turnContext.cachedInputTokens,
                  cacheCreationInputTokens: 0,
                },
              }
            : {}),
        },
      };
    } catch (err) {
      if (opts.abortController.signal.aborted) return;
      reportedError = true;
      const msg = err instanceof Error ? err.message : String(err);
      yield buildCodexRuntimeErrorEvent(msg, {
        usedNativeResume: canResumeNative,
        turnStarted,
        turnCompleted,
      });
    } finally {
      // Phase 4: report the process and the stream at the one moment the
      // runtime can CLASSIFY them. Deliberately not at the raw 'exit' event: a
      // codex child that exits after `turn.completed` is a turn finishing
      // normally, and telling the liveness controller "the process is gone"
      // while it still believes the run has work outstanding would be a false
      // positive it is required to act on. `abnormal` is limited to a close
      // nothing has explained yet — an error the runtime already reported, an
      // abort, or a completed turn are all explained.
      // Only an exit we actually OBSERVED is reported. A child we are about to
      // kill is not a child that exited, and saying it did would hand the
      // controller an observation the OS never made.
      if (childExited) {
        opts.liveness?.childProcessExited({
          pid: childForCleanup?.pid ?? null,
          exitCode: childForCleanup?.exitCode ?? null,
          signal: childForCleanup?.signalCode ?? null,
        });
      }
      opts.liveness?.streamClosed(
        !turnCompleted && !reportedError && !opts.abortController.signal.aborted,
      );
      // Guarantee no codex process (or its grandchild MCP subprocesses)
      // outlives this turn holding the thread-store writer lock. Idempotent:
      // killCodexChildTree no-ops if the process already exited cleanly.
      if (childForCleanup) killCodexChildTree(childForCleanup);
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

/** Is the newest `token_count` in this rollout THIS turn's reading?
 *
 *  Two questions, both asked of the same rules the observation judge uses
 *  (`markCoversPath` — canonicalized containment plus the session-id file-name
 *  convention), never of a string comparison written here:
 *
 *    1. does a mark of this turn cover the artifact at all?
 *    2. for a file we already had, did it GROW? A turn that failed before
 *       issuing a model request appends nothing, and the rollout still holds the
 *       previous turn's `token_count` — which carries no turn id, so "the newest
 *       event" is the previous turn's answer. Reusing it would publish a stale
 *       window as a live observation.
 *
 *  A `session-file` mark is the fresh-thread case: the CLI created that file
 *  during THIS turn, so everything in it is ours. */
function rolloutReadingBelongsToThisTurn(rolloutPath: string, marks: readonly ArtifactMark[]): boolean {
  if (rolloutPath === "") return false;
  const mark = markCoversPath(marks, rolloutPath);
  if (!mark) return false;
  if (mark.kind === "session-file") return true;
  try {
    return statSync(rolloutPath).size > mark.size;
  } catch {
    return false;
  }
}

function findCodexSessionFile(codexHome: string, threadId: string | undefined): string | null {
  if (!threadId) return null;
  const sessionsRoot = joinPath(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return null;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > 5) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = joinPath(dir, entry.name);
      if (entry.isFile() && entry.name.includes(threadId)) return full;
      if (entry.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

export function buildCurrentTurnPrompt(prompt: string): string {
  return [
    "Ensemble current-turn boundary:",
    "The request inside <current-user-request> is the active task for this turn.",
    "Use older thread context only as background. Do not resume, hand off, or continue older tasks unless this request explicitly asks for them.",
    "If older context conflicts with this request, follow this request.",
    "",
    "<current-user-request>",
    prompt,
    "</current-user-request>",
  ].join("\n");
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
  if (turns.length === 0) return buildCurrentTurnPrompt(opts.prompt);
  turns.push(buildCurrentTurnPrompt(opts.prompt));
  return [
    "This is an Ensemble pane transcript reconstructed from local history because no safe native Codex thread id was available.",
    "The transcript is background only. The final <current-user-request> block is the active task for this turn.",
    "Do not continue older tasks or peer handoffs from the transcript unless the current request explicitly asks for them.",
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
  usage?: CodexUsageSnapshot | null;
  errorMessage?: string;
}

export function buildCodexRuntimeErrorEvent(
  message: string,
  opts: { usedNativeResume: boolean; turnStarted: boolean; turnCompleted: boolean },
): RuntimeErrorEvent {
  if (isCodexEventStreamLagged(message)) {
    return {
      type: "error",
      message,
      code: "CODEX_EVENT_STREAM_LAGGED",
      recoverable: true,
      resumeScoped: false,
    };
  }
  if (isCodexThreadWriterConflict(message)) {
    // A previous codex process for this thread is (or was) still holding the
    // thread-store writer. Recoverable + resume-scoped: SessionManager clears
    // the cached thread id and auto-continues on a FRESH thread from local
    // history, instead of wedging the agent in ERROR.
    return {
      type: "error",
      message,
      code: "CODEX_THREAD_WRITER_CONFLICT",
      recoverable: true,
      resumeScoped: true,
    };
  }
  const interruptedNativeResume = opts.usedNativeResume && opts.turnStarted && !opts.turnCompleted;
  if (!interruptedNativeResume || !isNativeResumeTransportFailure(message)) return { type: "error", message };
  return {
    type: "error",
    message,
    code: "RESUME_TURN_INTERRUPTED",
    recoverable: true,
    resumeScoped: true,
  };
}

export function isCodexThreadWriterConflict(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes("already has an active writer") ||
    msg.includes("thread-store conflict") ||
    msg.includes("failed to initialize thread persistence")
  );
}

export function isNativeResumeTransportFailure(message: string): boolean {
  const msg = message.toLowerCase();
  if (isTransientCodexTimeoutFailure(msg)) return false;
  return (
    msg.includes("stream disconnected before completion") ||
    msg.includes("failed to send websocket request") ||
    msg.includes("os error 10053") ||
    msg.includes("connection reset") ||
    msg.includes("connection aborted") ||
    msg.includes("closed before completion") ||
    msg.includes("ended before turn.completed")
  );
}

function isTransientCodexTimeoutFailure(message: string): boolean {
  return (
    message.includes("request timed out") ||
    message.includes("timed out") ||
    /\btimeout\b/.test(message)
  );
}

export function isCodexEventStreamLagged(message: string): boolean {
  const msg = message.toLowerCase();
  return (
    msg.includes("in-process app-server event stream lagged") ||
    (msg.includes("app-server event stream") && msg.includes("dropped event")) ||
    (msg.includes("event stream lagged") && msg.includes("dropped event"))
  );
}

function normalizeUsage(value: unknown): TranslateOut["usage"] {
  return normalizeCodexUsageSnapshot(value);
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

export function translateEvent(
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

export function translateItem(
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
  if (item.type === "collab_tool_call" && isCompleted) {
    // codex 0.154: native subagent collaboration surfaces in the PARENT
    // thread's JSONL as `collab_tool_call` items. The subagent's own
    // intermediate messages are NOT inlined here (they run in separate
    // threads and come back merged into the final agent_message), so the
    // most we can honestly surface is "native subagent activity happened"
    // plus whatever metadata codex included. `tool` is the collaboration
    // primitive ("wait"/"spawn"/"notify"/...); observed samples have empty
    // receiver_thread_ids and null prompt, so only include them when set.
    const input: Record<string, unknown> = {
      tool: typeof item.tool === "string" ? item.tool : "unknown",
      status: typeof item.status === "string" ? item.status : "completed",
    };
    if (Array.isArray(item.receiver_thread_ids) && item.receiver_thread_ids.length > 0) {
      input.receiver_thread_ids = item.receiver_thread_ids;
    }
    if (typeof item.prompt === "string" && item.prompt.trim().length > 0) {
      input.prompt = item.prompt;
    }
    return {
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: {
          content: [
            {
              type: "tool_use",
              id: typeof item.id === "string" ? item.id : randomUUID(),
              name: "Subagent",
              input,
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
  if (item.type === "reasoning") {
    const text = typeof item.text === "string" ? item.text : "";
    if (!text || !isCompleted) return {};
    return {
      streamEvent: {
        type: "stream_event",
        session_id: synthSessionId,
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: text },
        },
      },
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: { content: [{ type: "thinking", thinking: text }] },
      },
    };
  }
  if (item.type === "error" && isCompleted) {
    // Per @openai/codex-sdk, an `error` *item* (ErrorItem) is explicitly a
    // NON-FATAL error surfaced inline — codex keeps going and still emits
    // turn.completed. This is distinct from ThreadErrorEvent (the top-level
    // `error` *event*), which is unrecoverable and stays routed to
    // errorMessage in translateEvent. Routing a non-fatal item to
    // errorMessage used to abort the turn, so benign notices such as
    // "Skill descriptions were shortened to fit the skills context budget.
    // Codex can still see every skill…" surfaced in the UI as an interrupted
    // turn even though nothing was actually interrupted. Surface it as a
    // labeled informational assistant block instead and let the turn run to
    // completion (unattended-continuity: never turn a warning into a stop).
    const text = typeof item.message === "string" ? item.message : JSON.stringify(item);
    return {
      assistantMessage: {
        type: "assistant",
        session_id: synthSessionId,
        message: { content: [{ type: "text" as const, text: `[codex] ${text}` }] },
      },
    };
  }
  // todo_list and other items: not surfacing in v1; future enhancement.
  void modelName;
  return {};
}
