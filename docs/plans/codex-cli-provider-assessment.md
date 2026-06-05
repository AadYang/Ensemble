# Codex CLI Provider Assessment

## Current Contract

`openai-codex` is the only Codex-specific provider in Ensemble. It wraps
`@openai/codex-sdk`, which wraps and spawns the user's local `codex` CLI.

This provider is intentionally different from `openai-local` and
`openai-compat`:

- it uses `codex login` / ChatGPT-account OAuth;
- it does not accept `baseUrl` or `apiKey`;
- it is billed as subscription usage inside Ensemble;
- it can use Codex sandbox settings and `codexWorkspace`;
- it must be treated as experimental because tool exposure is mediated by the
  Codex CLI process.

There is no separate Codex-branded API-key provider. OpenAI API-key usage belongs to
`openai-local`; third-party OpenAI-compatible usage belongs to `openai-compat`.

## Vendor Implementation Facts

From the installed `@openai/codex-sdk` README:

- the TypeScript SDK wraps the `codex` CLI from `@openai/codex`;
- it spawns the CLI and exchanges JSONL events over stdin/stdout;
- threads are persisted under `~/.codex/sessions`;
- `env` is a full environment override, not just a merge patch;
- SDK `config` is converted into repeated `--config key=value` CLI overrides.

That means Ensemble is not embedding a pure in-process Codex engine. It is
controlling a separate CLI whose config, auth, session persistence, MCP startup,
and backend behavior remain owned by Codex.

## Comparison With `anthropic-local`

`anthropic-local` is the closest product analogue: it also uses a user's local
login instead of API keys. The implementation is not equivalent.

| Area | `anthropic-local` | `openai-codex` |
| --- | --- | --- |
| SDK surface | `@anthropic-ai/claude-agent-sdk` | `@openai/codex-sdk` |
| Process model | SDK-managed Claude Code query | SDK spawns local `codex` CLI |
| System prompt isolation | First-class `systemPrompt` and `settingSources: []` | Prompt reconstructed; CLI still owns native runtime behavior |
| Peer tools | In-process MCP server map from SessionManager | HTTP MCP bridge injected into Codex CLI config |
| Tool discovery | SDK receives MCP server objects directly | Codex CLI must load TOML config and complete MCP discovery |
| Settings isolation | Explicit SDK option disables filesystem settings | Only partial isolation via per-agent `CODEX_HOME` |
| Session storage | SDK resume option passed by Ensemble | Codex persists under Codex home/session semantics |

The reusable ideas from `anthropic-local` are:

1. one local-OAuth provider per database;
2. no `baseUrl` / `apiKey`;
3. explicit runtime boundary and UI labeling;
4. avoid reading arbitrary user settings where the SDK allows it;
5. keep peer callbacks bound per session.

The non-reusable part is the important one: Claude accepts MCP servers as SDK
objects; Codex CLI only sees tools if its CLI-side MCP configuration starts and
discovers them. Ensemble cannot force that through the same in-process path.

## What Has Already Been Hardened

Current Codex CLI hardening in `CodexCliRuntime`:

- resolves a real `codex.exe` path instead of relying on bundled SDK lookup;
- registers per-session handlers in `mcp-bridge`;
- injects the internal MCP bridge through Codex TOML;
- uses bearer-token MCP auth for Codex's HTTP client;
- writes a per-session runtime `CODEX_HOME`;
- copies only `auth.json` from the normal user `~/.codex`;
- writes an Ensemble-owned minimal `config.toml`;
- sets `approval_policy = "never"` in that runtime config and passes
  `-c approval_policy="never"` to `codex exec`, because MCP tool approvals in
  non-interactive JSON mode cancel peer calls instead of delivering them;
- disables Codex `apps` for this runtime config;
- preserves the full process env when adding Ensemble MCP env vars;
- leaves sandbox unset unless the user configured a provider/agent override.
- drives `codex exec --json` directly instead of hiding behind the Codex SDK
  wrapper;
- runs `codex mcp list` with the same `CODEX_HOME` before each turn and fails
  early if the internal Ensemble MCP server is not visible.

These are valid local mitigations. They reduce file/config collisions, but they
do not turn Codex CLI into an isolated in-process SDK.

## Real Smoke Result

An end-to-end smoke script now exists at `core/scripts/codex-peer-smoke.ts`.
It starts the real Ensemble MCP bridge, creates a Codex source agent and a target
agent, then asks the Codex agent to call `peer_send` with a unique token.

On the tested Windows machine with the installed Codex CLI, the result was:

- Codex CLI was found and launched successfully;
- Ensemble generated an isolated `CODEX_HOME` and `config.toml`;
- `codex mcp --enable builtin_mcp --disable apps list` showed the internal
  `agentorch-internal-*` HTTP MCP server as enabled with bearer auth;
- `codex exec --json --enable builtin_mcp --disable apps ...` ran and produced
  model output;
- the model still replied that `peer_send` was not available in the session;
- the Ensemble MCP bridge received no HTTP requests during `codex exec`;
- the target agent received no smoke token.

This narrowed the failure: the generated config was readable by Codex CLI, but
the `exec` runtime did not connect to the configured HTTP MCP server or expose
those tools to the model. Passing `--sandbox danger-full-access`, registering
both `/mcp/internal` and `/api/mcp/internal`, and adding OAuth metadata routes
did not change that outcome.

The follow-up implementation switched Ensemble's internal Codex bridge from HTTP
MCP to stdio MCP:

- Codex now discovers `agentorch-internal-*` as a local stdio MCP server;
- the stdio server process proxies tool calls back to Ensemble core through a
  bearer-auth loopback endpoint;
- the real smoke test now shows Codex calling
  `mcp__agentorch-internal-*__peer_send`;
- Ensemble core receives `/api/mcp/internal-tool/<agentId>/peer_send`;
- the target agent receives the smoke token and the source Codex agent replies
  `done`.

So the current practical status is: Codex CLI peer messaging is implemented via
stdio MCP and has passed a real local smoke test. The old HTTP MCP path remains
diagnostic/fallback code, but it is not the supported Codex peer-tool path.

## Remaining Failure Modes

### External Codex CLI Sessions Can Still Be Affected

Per-session `CODEX_HOME` prevents Ensemble from writing the user's real
`~/.codex/config.toml`, but it cannot guarantee that ChatGPT/Codex backend
state, OAuth refresh behavior, native CLI session handling, or vendor-side
single-active-session semantics will never affect other Codex CLI windows.

If Codex CLI or its backend treats the same ChatGPT account as a shared actor,
Ensemble cannot fully isolate that from another `codex` CLI process.

### `peer_send` / `peer_query` Exposure Is Best-Effort

For Claude and OpenAI runtimes, Ensemble owns tool registration directly. For
Codex CLI, tool availability depends on:

- Codex CLI reading the generated TOML;
- `features.builtin_mcp` behavior in the installed Codex version;
- Codex CLI spawning the internal stdio MCP proxy;
- Codex completing MCP `initialize` / `tools/list`;
- Codex honoring `approval_policy = "never"` for MCP tool calls in `exec`;
- the model surfacing the discovered tools to the turn.

If any of those vendor-controlled steps fail, Ensemble can log and diagnose it,
but cannot guarantee the model will receive `peer_send` / `peer_query`.

The HTTP MCP smoke result shows that this is not merely hypothetical for HTTP:
`codex mcp list` can pass while `codex exec` still does not expose `peer_send`.
The stdio MCP bridge is the implemented workaround.

## Fixability Conclusion

### Can we make Codex CLI safer?

Yes, partially.

The current direction is valid:

- keep isolated per-agent `CODEX_HOME`;
- never mutate the user's real Codex config;
- keep full env passthrough;
- keep bearer MCP bridge;
- keep `apps = false`;
- keep direct `codex exec --json` control instead of the SDK wrapper;
- keep MCP preflight and stronger diagnostics for Codex MCP startup/tool-list absence;
- mark `openai-codex` as experimental in UI/docs.

### Can we make Codex CLI commercially reliable like `anthropic-local`?

No, not with the current vendor surface.

The blocker is architectural: `@openai/codex-sdk` is a CLI wrapper. Ensemble can
prepare config and environment, but it cannot control Codex CLI's internal MCP
startup, backend session behavior, or ChatGPT-account session interaction with
other Codex CLI processes.

Therefore the honest product position is:

- `openai-local`: reliable OpenAI API-key provider;
- `openai-compat`: reliable OpenAI-compatible provider, subject to upstream API
  quality;
- `openai-codex`: experimental local Codex CLI / ChatGPT subscription provider.

`openai-codex` can be improved and kept for users who explicitly want it, but
it should not be promised as the commercial-grade peer-agent notification path
unless OpenAI exposes a stable SDK/API surface that supports direct tool
registration or guaranteed MCP startup isolation.

The stdio MCP bridge is now implemented and has passed a real local smoke test.
Remaining commercial risk is still vendor-owned: future Codex CLI releases could
change MCP feature flags, stdio server spawning, or `exec` tool exposure. Keep
the smoke test as the release gate for the Codex CLI provider.
