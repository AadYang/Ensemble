// Static help content for `ensemble_help` MCP tool. Embedded as TS template
// strings so the SEA bundle doesn't need a filesystem read or a markdown
// loader. Authoring guidance: keep each topic <= ~120 lines, focused on what
// the agent needs to know to fulfill a user request inside Ensemble.

export const HELP_TOPICS: Record<string, string> = {
  overview: `Ensemble is a Tauri 2.x desktop app:
  - frontend: Next.js 16 (static-exported)
  - backend: Node 22 sidecar exposing a Fastify HTTP API + WebSocket on a per-launch
    auto-selected port (loopback only)
  - storage: a single SQLite file in the OS data dir (see data_dir topic)

Each AGENT runs on one of three RUNTIMES, chosen by its bound PROVIDER's kind:
  - anthropic-local / anthropic   → Claude SDK (spawns the user's local claude CLI)
  - openai-local / openai-compat  → @openai/agents (in-process HTTP to OpenAI-shape API)
  - openai-codex                  -> experimental Codex CLI runtime (spawns user's local codex CLI)

User-facing surfaces (DO NOT try to script these — point the user to them):
  - sidebar tree: list of agents, click to switch panes
  - provider panel: add / edit providers, refresh model lists
  - MCP panel: add / enable MCP servers
  - settings dialog (per agent): name, model, provider, permissionMode, sandbox, codexWorkspace
  - usage stats dialog: token + cost analytics
  - chat pane: slash commands + ↑/↓ history walking
  - permission popups: appear in-app when write tools are called

Inter-agent communication (you have these tools):
  - peer_send (push: continue / review / fork / raw modes)
  - peer_query (read-only history pull, doesn't run the peer)
  - conversation_search (read-only keyword search over prior user/assistant text;
    default scope team, fallback self when unteamed)
  - These are direct function tools on OpenAI providers, MCP tools on Claude
    providers, and stdio MCP tools on the experimental Codex CLI provider.
  - Codex peer tools are routed through Ensemble's local stdio MCP bridge and
    have passed real peer_send smoke testing. Codex still depends on the user's
    installed Codex CLI and ChatGPT login.
`,

  add_mcp_server: `To add an MCP server to Ensemble:

1. UI path (preferred — tell the user this):
   - Open the "MCP" panel (left sidebar)
   - Click "+ add server"
   - Fill in:
     · name (display label)
     · transport: stdio | http | sse
     · config (JSON), shape depends on transport:
         stdio:  { "command": "...", "args": [...], "env": { } }
         http:   { "url": "https://...", "headers": { } }
         sse:    same shape as http
   - Click save. Enabled by default.

2. Direct HTTP API (only if the user explicitly wants headless control):
   POST   /api/mcp-servers   { name, transport, config, agentId?, enabled? }
   GET    /api/mcp-servers
   PATCH  /api/mcp-servers/:id  { enabled?, name?, config? }
   DELETE /api/mcp-servers/:id
   Note: omit agentId for a GLOBAL server (available to every agent).
   Set agentId for a per-agent server.

3. SQLite path (last resort — UI does this for you):
   table: McpServer(id, agentId, name, transport, config (JSON text), enabled)

Cross-runtime notes (§3.6):
  - All three runtimes consume the same McpServer rows
  - Claude SDK gets them via the SDK's mcpServers map
  - OpenAI Agents gets them via @openai/agents MCPServer transports
  - Codex CLI gets external MCP rows via TOML overrides; Ensemble's internal
    peer_send / peer_query tools use a local stdio MCP bridge
  - sdk-type (createSdkMcpServer) entries are silently dropped on Codex —
    only stdio / http / sse cross all three

Example for the 高德 (Amap) MCP server (likely stdio):
  name: amap
  transport: stdio
  config: {
    "command": "npx",
    "args": ["-y", "@amap/amap-maps-mcp-server"],
    "env": { "AMAP_MAPS_API_KEY": "<user-supplied>" }
  }
  Verify package name + env-var name with the user / official docs first —
  do NOT hallucinate the exact npm package.
`,

  switch_provider: `To switch an agent's provider:

1. Slash command (in the chat input):
   - /provider             → opens an interactive picker (↑/↓ + Enter)
   - /provider <name>      → switches directly by provider name
   Switching auto-resets model to the provider's first available model.

2. UI: open Settings dialog → Provider dropdown.

3. HTTP API:
   PATCH /api/agents/:id { "providerId": "<uuid>" }

Providers are managed in the Provider panel. Adding/editing providers belongs
to the user — agents typically only SWITCH between existing providers.
`,

  switch_model: `To switch an agent's model:

1. Slash command:
   - /model             → opens an interactive picker filtered to current provider
   - /model <name>      → direct switch (must be in current provider's discovered list)

2. UI: Settings dialog → Model dropdown.

3. HTTP API:
   PATCH /api/agents/:id { "model": "<model-id>" }

If the user's provider has 0 models cached, tell them to open the Provider
panel and click the ↻ refresh button — Ensemble pulls /v1/models from upstream
and caches the result. Some providers (e.g., MiniMax) return empty lists; in
that case the manually-entered model fallback list is used.
`,

  create_agent: `To create a new agent:

1. WebSocket message (from frontend):
   { type: "create_agent", name, systemPrompt?, model?, providerId?,
     parentId?, codexWorkspace?, teamId? }

2. UI: "+" button in sidebar. Spawns a NewAgentDialog with name / provider / model fields.

3. HTTP: there is currently NO POST /agents endpoint — creation is WS-only.

Notes:
  - parentId makes the new agent a managed child (visible nested in sidebar tree)
  - teamId puts the new agent on an existing team (server validates the team
    exists). Members on a team get a TEAM CONTEXT block injected into their
    systemPrompt at turn start (see teams topic).
  - codexWorkspace is only valid when bound to an openai-codex provider; must be
    an absolute existing directory
  - When provider is openai-codex AND no codexWorkspace is given, the agent's
    cwd defaults to Ensemble's data dir. Set codexWorkspace for project work.
`,

  permissions: `Per-agent permissionMode controls how write tools (Edit / Write / Bash) gate:

  - default          : every call prompts the user via a permission popup
  - plan             : Edit / Write / Bash are auto-denied; model must call
                       ExitPlanMode with a markdown plan for user approval
  - acceptEdits      : Edit / Write auto-accept; Bash still prompts
  - bypassPermissions: nothing prompts (dangerous)
  - dontAsk          : everything not pre-approved is auto-denied

Per-turn auto-allow: clicking "Allow" on a permission popup caches that tool
name for the rest of the current turn. Subsequent calls of the SAME tool name
in the SAME turn skip the popup. "Deny" is NOT cached (the model can retry).

Codex runtime is launched non-interactively with approval_policy=never and uses
sandboxMode as the safety gate (see sandbox topic). Claude + OpenAI runtimes use
canUseTool → permission popup.

To set permissionMode:
  - UI: Settings dialog → permission mode dropdown
  - HTTP: PATCH /api/agents/:id { "permissionMode": "..." }
`,

  sandbox: `sandboxMode is the Codex runtime's safety gate. Ensemble disables
Codex CLI approval prompts for non-interactive agent turns so MCP calls such as
peer_send can complete; sandboxMode is what limits filesystem/network access.
Modes:

  - read-only           : no writes, no network (read-only investigation)
  - workspace-write     : writes inside cwd only, no network
  - danger-full-access  : unrestricted FS + network (DEFAULT; best Codex MCP compatibility)

Resolution order at turn start:
  1. agent.metadata.sandboxMode  (per-agent override; null = inherit)
  2. provider.defaultSandbox     (per-provider default; missing = danger-full-access)
  3. danger-full-access          (hard fallback)

Changing sandboxMode or provider.defaultSandbox drops Codex native resume info
for affected agents. This is required because codex exec resume cannot accept a
new --sandbox/--cd; the next user turn starts a fresh Codex session with the new
sandbox while preserving Ensemble's message history.

To set:
  - per-agent override: Settings dialog → "sandbox (codex)" dropdown
    (PATCH /api/agents/:id { "sandboxMode": "..."|null })
  - per-provider default: Provider panel → edit codex provider → sandbox dropdown
    (PATCH /api/providers/:id { "defaultSandbox": "..." })

Note: this is Codex-only. anthropic-* and openai-* providers ignore sandboxMode;
their gate is permissionMode + canUseTool popups.

When the user complains that "compiling outside the project directory fails",
the answer is usually: switch this agent's sandbox to danger-full-access for
that turn, or add the toolchain dirs to the workspace.
`,

  peer_messaging: `Two tools for cross-agent communication:

peer_send (async push — recipient processes as a new user turn):
  modes:
    - continue: "carry on my work-in-progress"
    - review:   "audit what I just produced"
    - fork:     "same task, different approach — don't retrace my path"
    - raw:      plain forwarding
  includeSource defaults to "auto": raw sends only the message; continue,
  review, and fork include a bounded <<<source-output>>> block with the
  sender's current or most recent key output.
  interrupt=true is emergency-only and requires interruptReason. Use it only
  when delayed delivery would make the message stale or cause wrong work.

peer_query (sync pull — read peer's recent text turns from DB):
  - Does NOT cause the target agent to run
  - Returns oldest → newest text turns, prefixed [user] / [assistant]
  - Tool-use noise filtered out
  - Use when you got a handoff and need more context than the embedded source

conversation_search (sync lookup - keyword search across prior text):
  - Does NOT cause any target agent to run; pure read-only DB query
  - Default scope is team. If the caller has no team, it falls back to self and
    says so in the result header
  - scope=self searches only this agent; scope=agent requires target name/UUID
  - Returns bounded matches with agent, seq, role, createdAt, and snippet
  - Filters tool-use/tool-result/raw event noise; only user/assistant text

Typical pattern:
  agent-A peer_send(target=B, mode=review, body="audit this")
    → B receives the handoff with A's last output embedded
    → if B needs more context, B peer_query(target=A, limit=30)
    → if B needs A to clarify, B peer_send(target=A, mode=raw, body="what did you mean by X")
`,

  slash_commands: `Available slash commands in Ensemble's chat input:

  /help                 show full help (overlaps with this topic)
  /clear                drop this agent's message history, start fresh
  /compact              ask the model to summarize prior context, then truncate
  /model [name]         switch model (picker if no arg)
  /provider [name]      switch provider (picker if no arg)
  /cost                 open the usage/cost dialog
  /status               print provider/model/permissionMode/sandbox/counts
  /mcp                  list enabled MCP servers
  /close                close current agent (preserves resume info)
  /restart              restart current agent
  /exit  /quit          alias of /close
  /help                 this help

In /model and /provider pickers: ↑/↓ navigate, Enter select, Esc cancel.
In the chat input: ↑/↓ walks through prior inputs for THIS agent (CLI-style).

Anything not starting with / (or starting with / but not matching above) is
sent to the model verbatim as a user message.
`,

  skills: `Skills are SKILL.md files that pre-package instructions for specific tasks.
Format: Anthropic-standard (Claude Code & Codex CLI compatible).

  ---
  name: slug-style-name
  description: When to use this skill (matters! auto-activation matches against this).
  tools: [Read, Grep, Glob]    # optional advisory list
  ---
  <markdown body — the actual instructions>

Source directories (priority high → low; first wins on name conflicts):
  1. project       <agent.codexWorkspace>/.claude/skills/<name>/SKILL.md
  2. ensemble      <DATA_DIR>/skills/<name>/SKILL.md   (managed via UI panel + HTTP API)
  3. claude-user   ~/.claude/skills/<name>/SKILL.md    (shared with Claude Code)
  4. codex-user    ~/.codex/skills/<name>/SKILL.md     (shared with Codex CLI)
  5. system        built-in runtime skills such as skill-creator / skill-installer

Flat-file form ~/.claude/skills/<name>.md (no directory) also accepted.

Use project / ensemble / user skills for long-lived behavior and precise
procedural memory. Keep them concise, invokeable, forceable, and auto-activatable
by description; do not paste large memory dumps into every agent prompt.

Activation:
  - AUTO: Ensemble scores skill descriptions against each user message,
    top-3 above a threshold are injected into systemPrompt as ACTIVE SKILLS.
  - EXPLICIT: model calls skill_invoke <name> for any skill it wants.
  - FORCED: per-agent metadata.forcedSkills always injects regardless of score.
  - DISABLED: per-agent metadata.disabledSkills skips a skill entirely.

Tools allow-list (frontmatter):
  - Claude / OpenAI runtimes: advisory — model is told to restrict but
    runtime doesn't enforce per-call.
  - Codex runtime: completely ignored (Ensemble runs Codex with
    approval_policy=never; sandboxMode is the actual safety boundary).

HTTP API (managed skills only — ensemble-source):
  GET    /api/skills            list all
  POST   /api/skills            create  { name, description, body, tools?, model? }
  PATCH  /api/skills/:name      edit
  DELETE /api/skills/:name      delete
  POST   /api/skills/reload     force re-scan of all source dirs

Tools you have inside Ensemble:
  skill_list                    enumerate available skills (with descriptions)
  skill_invoke <name>           load a skill's body into your context

Slash commands in chat:
  /skills                       list available + status
  /skill enable <name>          force-on for this agent
  /skill disable <name>         disable for this agent
`,

  teams: `A Team groups N agents that you've framed as collaborators on the
same workspace. Members can have different roles (system prompts) AND different
providers/models — that's the headline use: Claude for one role, GPT for
another, Codex for a third, all coordinated via peer_send / peer_query.

How to make one (UI):
  - Click "+ 团队" / "+ team" in the sidebar
  - Fill team name + optional description
  - Add N members. For each:
      role (free text — anything goes)
      provider + model (independently pickable per member)
      systemPrompt (what this role does, how they speak, what to avoid)
  - Submit → team row created + N agents created with teamId set

How to make one (HTTP API):
  POST   /api/teams                  { name, description? } → { id }
  GET    /api/teams                  list all teams + memberIds
  PATCH  /api/teams/:id              { name?, description? }
  DELETE /api/teams/:id              members revert to ungrouped (NOT deleted)
  Then create agents with create_agent WS message + teamId.

Editing a team in-place (UI: hover the team header → ✎):
  - Both name and team purpose (description) can be edited at any time.
  - When either changes, Ensemble auto-clears every member's lastSessionId
    pointer. Next turn opens a fresh CLI session so the updated TEAM CONTEXT
    actually takes effect (CLI sessions cache the old systemPrompt — without
    this reset, members would keep using the pre-edit context indefinitely).
  - In-flight messages already in a member's history are preserved.

Editing a single member's role / team membership (UI: agent ⚙ → settings):
  - systemPrompt field — the role's actual behavior description.
  - team dropdown — move this agent into / out of / between teams.
  - Both edits also clear that agent's lastSessionId (same reason).

Adding a member to an existing team (UI: hover team header → +):
  - Opens AddTeamMemberDialog (role / provider / model / systemPrompt).
  - Same fields as the create-team flow per-member, just one at a time.

What "being on a team" gives an agent:
  - A TEAM CONTEXT block injected into the systemPrompt (before user prompt,
    after primer): lists teammates by name + model + role hint. The agent
    knows who to call via peer_send when it needs help.
  - Sidebar grouping: members appear under a collapsible team header.
  - That's it — no orchestrator. Coordination is voluntary, agents must
    decide for themselves when to ping a teammate.

Ideas (NOT a feature list — just sparks for what people have built):
  - PR review trio: architect (claude) + line-by-line reviewer (gpt) +
    security auditor (codex with workspace-write sandbox)
  - Debate club: thesis + antithesis + synthesis, each on a different model
    to surface model-specific biases
  - Translation QA: source-language native + target-language native +
    domain expert, all read the draft and peer_send notes back
  - Story room: outliner + dialogue writer + continuity checker
  - Study buddy: explainer + quizzer + devil's advocate who challenges
    the explanations
  - Customer simulation: skeptical buyer + champion + price-negotiator,
    talked to by the user playing salesperson
  - Research trio: broad scanner (grep web/docs) + deep reader + summarizer

These are illustrations, not constraints. The team format is content-agnostic.

Deleting a team doesn't delete its agents — they become ungrouped. To wipe
the agents too, delete each one individually.

Cross-model is a first-class citizen: every member has its own provider /
model dropdown in the new-team dialog. Use it.
`,

  data_dir: `Ensemble's data directory:

  Windows:  %APPDATA%\\dev.ensemble.app\\        (e.g., C:\\Users\\<you>\\AppData\\Roaming\\dev.ensemble.app\\)
  macOS:    ~/Library/Application Support/dev.ensemble.app/
  Linux:    ~/.config/dev.ensemble.app/

Contents:
  - agentorch.db       single SQLite file (WAL mode)
  - agentorch.db-wal   write-ahead log (do not delete while app running)
  - agentorch.db-shm   shared memory file

Schema tables (relevant to most agent tasks):
  Agent        (id, name, providerId, model, systemPrompt, metadata JSON, codexWorkspace, status, parentId, createdAt)
  Provider     (id, name, kind, baseUrl, apiKey, models JSON, isDefault, disabled, metadata JSON, ...)
  McpServer    (id, agentId, name, transport, config JSON, enabled)
  Message      (id, agentId, seq, type, payload JSON, createdAt)
  Permission   (id, agentId, toolName, input JSON, decision, decidedAt)
  UsageEvent   (id, agentId, providerId, model, ... full snapshot for cost analytics)
  Workspace    (id, name, layout JSON, activeWindowId, createdAt)

To inspect the DB:
  - Find the path above
  - Use any SQLite client (DB Browser for SQLite, sqlite3 CLI, etc.)
  - DO NOT modify while Ensemble is running — close the app first or risk WAL corruption
`,
};

export const HELP_TOPIC_NAMES: readonly string[] = Object.freeze(Object.keys(HELP_TOPICS));
