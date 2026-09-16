// The cloud agent DTO, the upload builder, and the config signature.
//
// These three are ONE contract with two ends: the desktop builds a payload and
// signs it, the cloud accepts and stores it, and the two have to agree about
// which fields exist and which of them mean "the configuration changed". A
// field that is uploaded but not signed is a change the cloud never notices; a
// field that is signed but not uploaded is a signature that moves on its own.
//
// They live in `shared` — not in `desktop-ui/lib/cloud-api.ts` where the rest of
// the cloud client lives — because `desktop-ui` has no test runner, and the
// invariants here (no legacy path field is uploaded, signature keys === payload
// keys, the run ceiling rides in `metadata`) are exactly the ones that must be
// checked rather than asserted in a comment. The fetch/session half stays in the
// desktop client; it has no invariants, only requests.

import type { AgentSummary, TeamSummary } from "./protocol.js";
import type { RunPlanStatusView } from "./run-plan-view.js";

const SECRET_KEY_RE =
  /(api[_-]?key|secret|token|oauth|ssh|password|credential|cookie|private[_-]?key|env|authorization|bearer|access[_-]?token|refresh[_-]?token|session)/i;
const BLOCKED_METADATA_KEYS = new Set([
  "lastSessionId",
  "codexResumeSignature",
  "codexUsageSnapshot",
  "resumeMetadata",
  "providerSecrets",
  "providerCredentials",
]);

export interface CloudTeam {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  revision: number;
  updatedAt: string;
}

export interface CloudWorkspace {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudAgent {
  id: string;
  parentId: string | null;
  teamId: string | null;
  name: string;
  systemPrompt: string | null;
  model: string | null;
  providerKind: string | null;
  providerName: string | null;
  providerId: string | null;
  permissionMode: string | null;
  sandboxMode: string | null;
  reasoningEffort: string | null;
  projectRoot: string | null;
  /** READ-SIDE alias only. The server echoes the canonical `projectRoot` here
   *  for a client that predates it; this client never SENDS a path in it (see
   *  `buildCloudSnapshotFromLocal`). Optional so "the upload left it out" is a
   *  state the type admits rather than one it papers over with `null`. */
  codexWorkspace?: string | null;
  metadata: Record<string, unknown>;
  sortOrder: number;
  revision: number;
  updatedAt: string;
}

export interface CloudMessage {
  agentId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt?: string;
}

export interface CloudSnapshot {
  workspace: CloudWorkspace;
  teams: CloudTeam[];
  agents: CloudAgent[];
  messages: CloudMessage[];
}

export interface CloudSnapshotInput {
  teams: CloudTeam[];
  agents: CloudAgent[];
  messages: CloudMessage[];
}

export interface CloudMessageCursor {
  agentId: string;
  maxSeq: number;
}

export interface CloudSyncBatchInput extends Partial<CloudSnapshotInput> {
  expectedRevision?: number;
}

export interface CloudSyncBatchResult {
  workspace: CloudWorkspace;
  applied: {
    teams: number;
    agents: number;
    messages: number;
  };
  messageCursors: CloudMessageCursor[];
}

/** Read-only `/status` for a cloud agent.
 *
 *  Two answers, and the SECOND one is the point: `unavailable` is a complete
 *  answer that says the cloud holds this agent's synced configuration but no
 *  run plan, so a surface can print that instead of an empty report the user
 *  would read as "nothing to see". Neither answer is ever produced by falling
 *  back to a LOCAL agent that happens to share an id or a name — the lookup is
 *  scoped to the remote workspace, and this client has nothing to infer it
 *  from. */
export interface CloudAgentStatus {
  source: "snapshot" | "unavailable";
  planView: RunPlanStatusView | null;
  publishedAt: string | null;
  reason: string;
}

/** Where a desktop's last published plan for an agent lives inside the synced
 *  `metadata` bag.
 *
 *  The plan is not configuration: it changes every turn, so it rides in
 *  `metadata.publishedPlan` (where the cloud finds it) but is dropped before the
 *  config signature is computed. Signing it would make every turn look like a
 *  settings change and re-upload the workspace. */
export const PUBLISHED_PLAN_KEY = "publishedPlan";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** How deep a value may nest before this refuses to represent it.
 *
 *  This is NOT a data limit: nothing is clipped at any depth below it. It is a
 *  guard against a cyclic or pathological value turning a scrub into a runaway.
 *  Far past anything a real transcript produces (a message payload is about five
 *  levels), so reaching it means the value is not something we can represent —
 *  and the honest answer to that is a refusal, not "we sent most of it". */
const MAX_SCRUB_DEPTH = 32;

/** Thrown instead of sending a partly-scrubbed object to the cloud.
 *
 *  Replaces two silent trims: arrays were clipped to 500 entries and objects to
 *  100 keys. Both changed the data being synced without telling anyone, and a
 *  truncated sync is worse than a refused one — the remote workspace becomes a
 *  plausible-looking but WRONG copy that nothing downstream can distinguish from
 *  a complete one. A refusal is visible; a half-object is not. */
export class CloudSnapshotScrubError extends Error {
  readonly code = "CLOUD_SNAPSHOT_UNSCRUBBABLE";
  /** Where in the value the refusal happened, so it can be found and fixed. */
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`cannot scrub the value at ${path}: ${reason}; the sync is refused rather than sending a partial object`);
    this.name = "CloudSnapshotScrubError";
    this.path = path;
  }
}

export function isCloudSnapshotScrubError(err: unknown): err is CloudSnapshotScrubError {
  return err instanceof CloudSnapshotScrubError;
}

/** Remove secrets from a value, COMPLETELY.
 *
 *  Every array element and every key is visited at every depth — the 501st entry
 *  and the 101st key are scrubbed exactly like the first, and nothing is dropped
 *  from the object that gets uploaded. The only failure mode is the depth guard
 *  above, and it throws rather than trimming. */
export function scrubSecrets(value: unknown, path = "$", depth = 0): unknown {
  if (depth > MAX_SCRUB_DEPTH) {
    throw new CloudSnapshotScrubError(path, `it nests deeper than ${MAX_SCRUB_DEPTH} levels`);
  }
  if (value == null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => scrubSecrets(entry, `${path}[${index}]`, depth + 1));
  }
  // A value JSON could not have carried (a function, a symbol, a bigint) has no
  // representation in the payload. `null` is that representation; it is not a
  // truncation of one.
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) || BLOCKED_METADATA_KEYS.has(key)) continue;
    out[key] = scrubSecrets(nested, `${path}.${key}`, depth + 1);
  }
  return out;
}

function messageTypeFromPayload(msg: PersistedMessageLike): string {
  if (isRecord(msg.msg) && typeof msg.msg.type === "string") return msg.msg.type;
  return "system";
}

/** The stored message shape this builder reads. Structural on purpose: the
 *  desktop's `PersistedMessage` satisfies it, and nothing else has to. */
export interface PersistedMessageLike {
  seq: number;
  msg: unknown;
}

/** The agent fields the upload carries — and the exact set
 *  `cloudConfigSignature` signs.
 *
 *  One list, because the two halves are useless apart: a field that is uploaded
 *  but not signed is a change the cloud never notices (the signature says
 *  "nothing changed" and the sync is skipped), and a field that is signed but
 *  not uploaded is a signature that moves on its own. A gate in
 *  `cloud-config.test.ts` asserts that the builder's output keys and this list
 *  are the same set, so adding a field to one side without the other fails
 *  loudly instead of drifting.
 *
 *  `revision` and `updatedAt` are NOT here: the server owns them. */
export const CLOUD_AGENT_FIELDS = [
  "id",
  "parentId",
  "teamId",
  "name",
  "systemPrompt",
  "model",
  "providerKind",
  "providerName",
  "providerId",
  "permissionMode",
  "sandboxMode",
  "reasoningEffort",
  "projectRoot",
  "metadata",
  "sortOrder",
] as const;

/** The agent fields the server assigns. Listed so the parity gate can state the
 *  full expected key set instead of "everything else". */
export const CLOUD_AGENT_SERVER_FIELDS = ["revision", "updatedAt"] as const;

export function buildCloudSnapshotFromLocal(input: {
  agents: AgentSummary[];
  teams: TeamSummary[];
  messagesByAgent: Record<string, PersistedMessageLike[]>;
}): CloudSnapshotInput {
  const teams: CloudTeam[] = input.teams.map((team, index) => ({
    id: team.id,
    name: team.name,
    description: team.description,
    sortOrder: index,
    revision: 0,
    updatedAt: team.createdAt,
  }));

  const agents: CloudAgent[] = input.agents.map((agent, index) => ({
    id: agent.id,
    parentId: agent.parentId,
    teamId: agent.teamId,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    providerKind: null,
    providerName: null,
    providerId: agent.providerId,
    permissionMode: agent.permissionMode,
    sandboxMode: agent.sandboxMode,
    reasoningEffort: agent.reasoningEffort,
    projectRoot: agent.projectRoot,
    // NOT `codexWorkspace`. That name is the retired column, and putting the
    // project path in it made the upload carry the same directory twice under
    // two names — a legacy SHAPE, not just a legacy key, kept alive by the one
    // writer that was supposed to stop using it. The canonical `projectRoot` is
    // the only name this client sends; the server still ACCEPTS the old alias
    // from older builds, and echoes the canonical value back for older readers.
    metadata: {
      forcedSkills: agent.forcedSkills,
      disabledSkills: agent.disabledSkills,
      closed: agent.closed,
      // The run ceiling rides in `metadata` under the SAME key the local agent
      // metadata uses — one name, one meaning on both sides. It is not a new
      // top-level cloud column: `metadata` is already the synced extension bag,
      // and the signature covers it, so this value cannot change without the
      // sync noticing.
      maxRunDurationMs: agent.maxRunDurationMs,
    },
    sortOrder: index,
    revision: 0,
    updatedAt: agent.createdAt,
  }));

  const messages: CloudMessage[] = [];
  for (const agent of input.agents) {
    const agentMessages = input.messagesByAgent[agent.id] ?? [];
    for (const msg of agentMessages) {
      messages.push({
        agentId: agent.id,
        seq: msg.seq,
        type: messageTypeFromPayload(msg),
        payload: scrubSecrets(msg.msg),
      });
    }
  }
  return { teams, agents, messages };
}

function stableConfigMetadata(value: unknown): unknown {
  const scrubbed = scrubSecrets(value);
  if (!isRecord(scrubbed)) return {};
  // The published plan is NOT configuration. It changes on every turn (a new
  // plan hash, a new `resolvedAt`), so leaving it in the signature would make
  // every turn look like a settings change and re-upload every agent on the
  // next sync. It is uploaded, and it is real — it is just not part of "have
  // the settings changed".
  const { [PUBLISHED_PLAN_KEY]: _publishedPlan, ...config } = scrubbed;
  return sortObject(config);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortObject(value[key]);
  }
  return out;
}

export function cloudConfigSignature(snapshot: { teams: CloudTeam[]; agents: CloudAgent[] }): string {
  const teams = [...snapshot.teams]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((team) => ({
      id: team.id,
      name: team.name,
      description: team.description,
      sortOrder: team.sortOrder,
    }));
  const agents = [...snapshot.agents]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((agent) => signedAgentFields(agent));
  return JSON.stringify({ teams, agents });
}

/** The signed projection of one agent: EXACTLY `CLOUD_AGENT_FIELDS`, so the
 *  signature cannot cover a field the payload does not carry (it would move on
 *  its own) or miss one the payload does (the change would never sync).
 *
 *  `metadata` is scrubbed and key-sorted because it is uploaded scrubbed: signing
 *  the raw object would make a secret-only change look like a config change. */
function signedAgentFields(agent: CloudAgent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CLOUD_AGENT_FIELDS) {
    if (field === "metadata") {
      out.metadata = stableConfigMetadata(agent.metadata);
      continue;
    }
    out[field] = agent[field];
  }
  return out;
}
