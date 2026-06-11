import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { AgentSummary, CloudRealtimeClientMsg, CloudRealtimeRole, CloudRealtimeServerMsg } from "@agentorch/shared";
import type { CloudAgent, CloudStore } from "./store.js";
import { authenticateCloudToken } from "./session-auth.js";

export type CloudSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly OPEN: number;
};

interface AccountSockets {
  desktop: CloudSocket | null;
  webs: Set<CloudSocket>;
  inFlightAgents: Set<string>;
  inFlightConfigs: Set<string>;
}

const cloudIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const configPatchSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    systemPrompt: z.string().max(32_000).nullable().optional(),
    model: z.string().min(1).max(160).optional(),
    providerId: z.string().max(128).nullable().optional(),
    permissionMode: z.enum(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]).optional(),
    sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable().optional(),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional(),
    codexWorkspace: z.string().max(512).nullable().optional(),
    teamId: z.string().max(128).nullable().optional(),
    closed: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "config patch must include at least one field");
const cloudRealtimeClientMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("remote_send"),
    requestId: z.string().min(1).max(128),
    workspaceId: cloudIdSchema,
    agentId: cloudIdSchema,
    text: z.string().min(1).max(64_000),
  }),
  z.object({
    type: z.literal("config_request"),
    requestId: z.string().min(1).max(128),
    workspaceId: cloudIdSchema,
    agentId: cloudIdSchema,
    patch: configPatchSchema,
  }),
  z.object({
    type: z.literal("config_ack"),
    requestId: z.string().min(1).max(128),
    workspaceId: cloudIdSchema,
    agentId: cloudIdSchema,
    agent: z.unknown(),
  }),
  z.object({
    type: z.literal("remote_ack"),
    requestId: z.string().min(1).max(128),
    workspaceId: cloudIdSchema,
    agentId: cloudIdSchema,
  }),
  z.object({
    type: z.literal("remote_error"),
    requestId: z.string().min(1).max(128).optional(),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(1_000),
    workspaceId: cloudIdSchema.optional(),
    agentId: cloudIdSchema.optional(),
  }),
  z.object({
    type: z.literal("agent_status"),
    workspaceId: cloudIdSchema,
    agentId: cloudIdSchema,
    status: z.enum(["idle", "running", "awaiting_permission", "awaiting_user_input", "error", "done"]),
  }),
  z.object({
    type: z.literal("agent_message"),
    workspaceId: cloudIdSchema,
    agentId: cloudIdSchema,
    seq: z.number().int(),
    msg: z.unknown(),
  }),
]);

function send(socket: CloudSocket, msg: CloudRealtimeServerMsg): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function socketSetDelete(set: Set<CloudSocket>, socket: CloudSocket): void {
  if (set.has(socket)) set.delete(socket);
}

export class CloudRealtimeHub {
  private readonly accounts = new Map<string, AccountSockets>();

  connect(accountId: string, role: CloudRealtimeRole, socket: CloudSocket): boolean {
    const entry = this.account(accountId);
    if (role === "desktop") {
      if (entry.desktop && entry.desktop.readyState === entry.desktop.OPEN) {
        send(socket, {
          type: "remote_error",
          code: "DESKTOP_ALREADY_ONLINE",
          message: "Another desktop client is already online for this account.",
        });
        socket.close(4409, "desktop_already_online");
        return false;
      }
      entry.desktop = socket;
      send(socket, { type: "hello", role, desktopOnline: true, serverTime: new Date().toISOString() });
      this.broadcastOnline(accountId, true);
      return true;
    }
    entry.webs.add(socket);
    send(socket, { type: "hello", role, desktopOnline: this.isDesktopOnline(accountId), serverTime: new Date().toISOString() });
    return true;
  }

  disconnect(accountId: string, role: CloudRealtimeRole, socket: CloudSocket): void {
    const entry = this.accounts.get(accountId);
    if (!entry) return;
    if (role === "desktop") {
      if (entry.desktop === socket) {
        entry.desktop = null;
        entry.inFlightAgents.clear();
        entry.inFlightConfigs.clear();
        this.broadcastOnline(accountId, false);
      }
    } else {
      socketSetDelete(entry.webs, socket);
    }
    if (!entry.desktop && entry.webs.size === 0) this.accounts.delete(accountId);
  }

  handle(accountId: string, role: CloudRealtimeRole, socket: CloudSocket, msg: CloudRealtimeClientMsg): void {
    if (msg.type === "ping") {
      send(socket, { type: "online_status", desktopOnline: this.isDesktopOnline(accountId) });
      return;
    }
    if (role === "web") {
      if (msg.type !== "remote_send" && msg.type !== "config_request") {
        send(socket, {
          type: "remote_error",
          code: "UNSUPPORTED_WEB_MESSAGE",
          message: "Web clients can only send remote_send or config_request messages in this beta.",
        });
        return;
      }
      if (msg.type === "remote_send") this.forwardRemoteSend(accountId, socket, msg);
      else this.forwardConfigRequest(accountId, socket, msg);
      return;
    }
    this.forwardDesktopEvent(accountId, msg);
  }

  sendTo(socket: CloudSocket, msg: CloudRealtimeServerMsg): void {
    send(socket, msg);
  }

  broadcastConfigUpdated(accountId: string, msg: Extract<CloudRealtimeServerMsg, { type: "config_updated" }>): void {
    const webs = this.accounts.get(accountId)?.webs;
    if (!webs) return;
    for (const web of webs) send(web, msg);
  }

  isDesktopOnline(accountId: string): boolean {
    const desktop = this.accounts.get(accountId)?.desktop;
    return !!desktop && desktop.readyState === desktop.OPEN;
  }

  webCount(accountId: string): number {
    return this.accounts.get(accountId)?.webs.size ?? 0;
  }

  private account(accountId: string): AccountSockets {
    let entry = this.accounts.get(accountId);
    if (!entry) {
      entry = { desktop: null, webs: new Set(), inFlightAgents: new Set(), inFlightConfigs: new Set() };
      this.accounts.set(accountId, entry);
    }
    return entry;
  }

  private forwardRemoteSend(accountId: string, source: CloudSocket, msg: Extract<CloudRealtimeClientMsg, { type: "remote_send" }>): void {
    const entry = this.accounts.get(accountId);
    const desktop = entry?.desktop;
    if (!desktop || desktop.readyState !== desktop.OPEN) {
      send(source, {
        type: "remote_error",
        requestId: msg.requestId,
        code: "DESKTOP_OFFLINE",
        message: "No desktop client is online for this account.",
        workspaceId: msg.workspaceId,
        agentId: msg.agentId,
      });
      return;
    }
    const busyKey = remoteAgentKey(msg.workspaceId, msg.agentId);
    if (entry.inFlightAgents.has(busyKey)) {
      send(source, {
        type: "remote_error",
        requestId: msg.requestId,
        code: "AGENT_BUSY",
        message: "This agent is already running a remote request.",
        workspaceId: msg.workspaceId,
        agentId: msg.agentId,
      });
      return;
    }
    entry.inFlightAgents.add(busyKey);
    send(desktop, msg);
  }

  private forwardConfigRequest(accountId: string, source: CloudSocket, msg: Extract<CloudRealtimeClientMsg, { type: "config_request" }>): void {
    const entry = this.accounts.get(accountId);
    const desktop = entry?.desktop;
    if (!desktop || desktop.readyState !== desktop.OPEN) {
      send(source, {
        type: "remote_error",
        requestId: msg.requestId,
        code: "DESKTOP_OFFLINE",
        message: "No desktop client is online for this account.",
        workspaceId: msg.workspaceId,
        agentId: msg.agentId,
      });
      return;
    }
    const busyKey = remoteAgentKey(msg.workspaceId, msg.agentId);
    if (entry.inFlightConfigs.has(busyKey)) {
      send(source, {
        type: "remote_error",
        requestId: msg.requestId,
        code: "CONFIG_BUSY",
        message: "This agent already has a remote settings change in progress.",
        workspaceId: msg.workspaceId,
        agentId: msg.agentId,
      });
      return;
    }
    entry.inFlightConfigs.add(busyKey);
    send(desktop, msg);
  }

  private forwardDesktopEvent(accountId: string, msg: CloudRealtimeClientMsg): void {
    if (
      msg.type !== "config_ack" &&
      msg.type !== "remote_ack" &&
      msg.type !== "remote_error" &&
      msg.type !== "agent_status" &&
      msg.type !== "agent_message"
    ) {
      return;
    }
    if (msg.type === "remote_error") {
      if (msg.workspaceId && msg.agentId) this.releaseInFlight(accountId, msg.workspaceId, msg.agentId);
      if (msg.workspaceId && msg.agentId) this.releaseConfigInFlight(accountId, msg.workspaceId, msg.agentId);
    } else if (msg.type === "agent_status" && (msg.status === "done" || msg.status === "error" || msg.status === "idle")) {
      this.releaseInFlight(accountId, msg.workspaceId, msg.agentId);
    } else if (msg.type === "config_ack") {
      this.releaseConfigInFlight(accountId, msg.workspaceId, msg.agentId);
      return;
    }
    const webs = this.accounts.get(accountId)?.webs;
    if (!webs) return;
    for (const web of webs) send(web, msg);
  }

  private releaseInFlight(accountId: string, workspaceId: string, agentId: string): void {
    this.accounts.get(accountId)?.inFlightAgents.delete(remoteAgentKey(workspaceId, agentId));
  }

  private releaseConfigInFlight(accountId: string, workspaceId: string, agentId: string): void {
    this.accounts.get(accountId)?.inFlightConfigs.delete(remoteAgentKey(workspaceId, agentId));
  }

  private broadcastOnline(accountId: string, desktopOnline: boolean): void {
    const webs = this.accounts.get(accountId)?.webs;
    if (!webs) return;
    for (const web of webs) send(web, { type: "online_status", desktopOnline });
  }
}

function remoteAgentKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`;
}

export function registerCloudRealtimeRoutes(app: FastifyInstance, store: CloudStore, hub = new CloudRealtimeHub()): CloudRealtimeHub {
  app.register(websocket);

  app.register(async (instance) => {
    instance.get("/v1/cloud/realtime", { websocket: true }, (socket, req) => {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      const role = url.searchParams.get("role");
      const contextPromise = (async (): Promise<{ accountId: string; role: CloudRealtimeRole } | null> => {
        if (role !== "desktop" && role !== "web") {
          send(socket, { type: "remote_error", code: "BAD_ROLE", message: "role must be desktop or web." });
          socket.close(4400, "bad_role");
          return null;
        }
        const auth = await authenticateCloudToken(token, store);
        if (!auth) {
          send(socket, { type: "remote_error", code: "UNAUTHORIZED", message: "Cloud session is invalid or expired." });
          socket.close(4401, "unauthorized");
          return null;
        }
        const accountId = auth.account.id;
        if (!hub.connect(accountId, role, socket)) return null;
        return { accountId, role };
      })();

      socket.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const context = await contextPromise;
        if (!context) return;
        const text = Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : Buffer.from(raw as ArrayBuffer).toString("utf8");
        try {
          const parsed = cloudRealtimeClientMsgSchema.parse(JSON.parse(text)) as CloudRealtimeClientMsg;
          if (parsed.type === "remote_send" && context.role === "web") {
            if (!hub.isDesktopOnline(context.accountId)) {
              hub.handle(context.accountId, context.role, socket, parsed);
              return;
            }
            if (!(await ensureCloudAgent(context.accountId, parsed.workspaceId, parsed.agentId, parsed.requestId, socket, store))) {
              return;
            }
          }
          if (parsed.type === "config_request" && context.role === "web") {
            if (!hub.isDesktopOnline(context.accountId)) {
              hub.handle(context.accountId, context.role, socket, parsed);
              return;
            }
            if (!(await ensureCloudAgent(context.accountId, parsed.workspaceId, parsed.agentId, parsed.requestId, socket, store))) {
              return;
            }
          }
          if (
            context.role === "desktop" &&
            (parsed.type === "agent_status" || parsed.type === "agent_message" || parsed.type === "config_ack") &&
            !(await ensureCloudAgent(context.accountId, parsed.workspaceId, parsed.agentId, undefined, socket, store))
          ) {
            return;
          }
          if (context.role === "desktop" && parsed.type === "config_ack") {
            let result: Awaited<ReturnType<typeof applyConfigAck>>;
            try {
              result = await applyConfigAck(context.accountId, parsed.workspaceId, parsed.agentId, parsed.agent, store);
            } catch (err) {
              hub.handle(context.accountId, context.role, socket, {
                type: "remote_error",
                requestId: parsed.requestId,
                code: "CONFIG_APPLY_FAILED",
                message: err instanceof Error ? err.message : "Remote settings change failed.",
                workspaceId: parsed.workspaceId,
                agentId: parsed.agentId,
              });
              return;
            }
            hub.sendTo(socket, {
              type: "sync_result",
              workspaceId: parsed.workspaceId,
              revision: result.revision,
              messageCursors: result.messageCursors,
            });
            hub.handle(context.accountId, context.role, socket, {
              type: "config_ack",
              requestId: parsed.requestId,
              workspaceId: parsed.workspaceId,
              agentId: parsed.agentId,
              agent: result.agent,
            });
            hub.broadcastConfigUpdated(context.accountId, {
              type: "config_updated",
              requestId: parsed.requestId,
              workspaceId: parsed.workspaceId,
              agentId: parsed.agentId,
              agent: result.agent,
              revision: result.revision,
            });
            return;
          }
          if (context.role === "desktop" && parsed.type === "agent_message" && parsed.seq >= 0) {
            const result = await store.syncBatch(context.accountId, parsed.workspaceId, {
              messages: [
                {
                  agentId: parsed.agentId,
                  seq: parsed.seq,
                  type: messageType(parsed.msg),
                  payload: parsed.msg,
                },
              ],
            });
            hub.sendTo(socket, {
              type: "sync_result",
              workspaceId: parsed.workspaceId,
              revision: result.workspace.revision,
              messageCursors: result.messageCursors,
            });
          }
          hub.handle(context.accountId, context.role, socket, parsed);
        } catch (err) {
          send(socket, {
            type: "remote_error",
            code: "BAD_REQUEST",
            message: err instanceof Error ? err.message : "invalid realtime message",
          });
        }
      });

      socket.on("close", () => {
        void contextPromise.then((context) => {
          if (context) hub.disconnect(context.accountId, context.role, socket);
        });
      });
    });
  });

  return hub;
}

function messageType(msg: unknown): string {
  if (msg && typeof msg === "object" && "type" in msg && typeof (msg as { type?: unknown }).type === "string") {
    return (msg as { type: string }).type;
  }
  return "system";
}

async function ensureCloudAgent(
  accountId: string,
  workspaceId: string,
  agentId: string,
  requestId: string | undefined,
  socket: CloudSocket,
  store: CloudStore,
): Promise<boolean> {
  const snapshot = await store.getSnapshot(accountId, workspaceId);
  if (!snapshot) {
    send(socket, {
      type: "remote_error",
      requestId,
      code: "WORKSPACE_NOT_FOUND",
      message: "Cloud workspace was not found for this account.",
      workspaceId,
      agentId,
    });
    return false;
  }
  if (!snapshot.agents.some((agent) => agent.id === agentId)) {
    send(socket, {
      type: "remote_error",
      requestId,
      code: "AGENT_NOT_FOUND",
      message: "Agent is not part of this cloud workspace.",
      workspaceId,
      agentId,
    });
    return false;
  }
  return true;
}

async function applyConfigAck(
  accountId: string,
  workspaceId: string,
  agentId: string,
  agent: unknown,
  store: CloudStore,
): Promise<{ agent: AgentSummary; revision: number; messageCursors: Array<{ agentId: string; maxSeq: number }> }> {
  const summary = agentSummarySchema.parse(agent);
  if (summary.id !== agentId) throw new Error("config_ack agent id mismatch");
  const snapshot = await store.getSnapshot(accountId, workspaceId);
  const existing = snapshot?.agents.find((entry) => entry.id === agentId);
  if (!existing) throw new Error("agent_not_found");
  const result = await store.syncBatch(accountId, workspaceId, {
    agents: [cloudAgentFromSummary(existing, summary)],
  });
  return { agent: summary, revision: result.workspace.revision, messageCursors: result.messageCursors };
}

const agentSummarySchema = z.object({
  id: cloudIdSchema,
  name: z.string().min(1).max(160),
  parentId: z.string().nullable(),
  status: z.enum(["idle", "running", "awaiting_permission", "awaiting_user_input", "error", "done"]),
  model: z.string().min(1).max(160),
  systemPrompt: z.string().nullable(),
  providerId: z.string().nullable(),
  codexWorkspace: z.string().nullable(),
  permissionMode: z.enum(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]),
  sandboxMode: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable(),
  reasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).nullable(),
  teamId: z.string().nullable(),
  forcedSkills: z.array(z.string()).max(500),
  disabledSkills: z.array(z.string()).max(500),
  closed: z.boolean(),
  hasResumeInfo: z.boolean(),
  createdAt: z.string(),
});

function cloudAgentFromSummary(existing: CloudAgent, summary: AgentSummary): CloudAgent {
  return {
    ...existing,
    id: summary.id,
    parentId: summary.parentId,
    teamId: summary.teamId,
    name: summary.name,
    systemPrompt: summary.systemPrompt,
    model: summary.model,
    providerId: summary.providerId,
    permissionMode: summary.permissionMode,
    sandboxMode: summary.sandboxMode,
    reasoningEffort: summary.reasoningEffort,
    codexWorkspace: summary.codexWorkspace,
    metadata: {
      ...existing.metadata,
      forcedSkills: summary.forcedSkills,
      disabledSkills: summary.disabledSkills,
      closed: summary.closed,
    },
  };
}
