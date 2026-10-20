"use client";

import { useEffect, useState } from "react";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  patchMcpServer,
  type McpServerDTO,
  type McpTransport,
} from "@/lib/mcp-api";
import { useT } from "@/i18n/useT";
import { getDialog } from "@/lib/dialog";
import { CollapsibleSection, PANEL_OPEN_KEYS } from "./CollapsibleSection";

const STDIO_TEMPLATE = `{
  "command": "node",
  "args": ["./mcp-server.js"],
  "env": {}
}`;
const HTTP_TEMPLATE = `{
  "url": "http://localhost:8080/mcp",
  "headers": {}
}`;

export function McpServerPanel({
  agents = {},
}: {
  /** Agent directory, used only to label which agent owns a scoped server. */
  agents?: Record<string, { name: string }>;
} = {}) {
  const [servers, setServers] = useState<McpServerDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [name, setName] = useState("");
  const [configText, setConfigText] = useState(STDIO_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  /** "" = global; otherwise the agent this new server is private to. */
  const [scope, setScope] = useState("");
  const t = useT();

  const refresh = async () => {
    try {
      // The management view: every row, including per-agent ones. Listing
      // globals only made a correctly scoped server look like it had never
      // been saved (the panel read 0/0 while the row existed).
      const list = await listMcpServers({ all: true });
      setServers(list);
    } catch (err) {
      console.warn("listMcpServers failed", err);
    }
  };

  const scopeLabel = (agentId: string | null): string => {
    if (!agentId) return t("mcp.scope.global");
    return agents[agentId]?.name ?? t("mcp.scope.unknown");
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onTransportChange = (t: McpTransport) => {
    setTransport(t);
    setConfigText(t === "stdio" ? STDIO_TEMPLATE : HTTP_TEMPLATE);
  };

  const onAdd = async () => {
    if (!name.trim()) {
      setError("name required");
      return;
    }
    let parsed: object;
    try {
      parsed = JSON.parse(configText);
    } catch (e) {
      setError("config: " + (e as Error).message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createMcpServer({
        name: name.trim(),
        transport,
        config: parsed as never,
        // Explicit scope: "" means global, exactly like omitting agentId.
        agentId: scope || null,
      });
      setName("");
      setConfigText(transport === "stdio" ? STDIO_TEMPLATE : HTTP_TEMPLATE);
      setAdding(false);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (s: McpServerDTO) => {
    try {
      await patchMcpServer(s.id, { enabled: !s.enabled });
      await refresh();
    } catch (err) {
      console.warn("toggle failed", err);
    }
  };

  const onDelete = async (s: McpServerDTO) => {
    const ok = await getDialog().confirm({ title: t("mcp.confirmDelete", { name: s.name }), danger: true });
    if (!ok) return;
    try {
      await deleteMcpServer(s.id);
      await refresh();
    } catch (err) {
      console.warn("delete failed", err);
    }
  };

  return (
    <CollapsibleSection
      storageKey={PANEL_OPEN_KEYS.mcp}
      label={t("mcp.label")}
      badge={`${servers.filter((s) => s.enabled).length}/${servers.length}`}
    >
      <div className="flex flex-col gap-1">
          {servers.length === 0 && (
            <div className="px-2 py-1 text-[var(--text-faint)]">{t("mcp.empty")}</div>
          )}
          {servers.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1 px-1 py-0.5 border border-[var(--border)] bg-[var(--bg-pane)]"
            >
              <span className={`status-dot ${s.enabled ? "running" : "idle"}`} />
              <span className="truncate flex-1" title={`${s.name} · ${scopeLabel(s.agentId)} · ${s.transport}`}>
                {s.name}
              </span>
              <span
                className={`shrink-0 max-w-[6.5rem] truncate text-[10px] ${
                  s.agentId ? "text-[var(--accent)]" : "text-[var(--text-faint)]"
                }`}
                title={scopeLabel(s.agentId)}
              >
                {scopeLabel(s.agentId)}
              </span>
              <span className="text-[var(--text-faint)] text-[10px]">{s.transport}</span>
              <button
                onClick={() => onToggle(s)}
                className="px-1 text-[var(--text-dim)] hover:text-[var(--accent)]"
                title={s.enabled ? t("mcp.toggle.disable") : t("mcp.toggle.enable")}
              >
                {s.enabled ? "○" : "●"}
              </button>
              <button
                onClick={() => onDelete(s)}
                className="px-1 text-[var(--text-dim)] hover:text-[var(--err)]"
                title={t("mcp.delete.title")}
              >
                ×
              </button>
            </div>
          ))}
          {adding ? (
            <div className="flex flex-col gap-1 mt-1 p-2 border border-[var(--border)] bg-[var(--bg-pane)]">
              <input
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
                placeholder={t("mcp.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <select
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                title={t("mcp.scope.label")}
                aria-label={t("mcp.scope.label")}
              >
                <option value="">{t("mcp.scope.global")}</option>
                {Object.entries(agents)
                  .sort((a, b) => a[1].name.localeCompare(b[1].name))
                  .map(([id, a]) => (
                    <option key={id} value={id}>
                      {a.name}
                    </option>
                  ))}
              </select>
              <select
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)]"
                value={transport}
                onChange={(e) => onTransportChange(e.target.value as McpTransport)}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
              <textarea
                className="bg-[var(--bg)] border border-[var(--border)] px-1 py-0.5 outline-none focus:border-[var(--accent)] font-mono text-[10px] min-h-24"
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
              />
              {error && <div className="text-[var(--err)] text-[10px]">{error}</div>}
              <div className="flex gap-1">
                <button
                  onClick={onAdd}
                  disabled={busy}
                  className="flex-1 px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black transition-colors disabled:opacity-30"
                >
                  {t("mcp.add.button")}
                </button>
                <button
                  onClick={() => {
                    setAdding(false);
                    setError(null);
                  }}
                  className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
                >
                  {t("mcp.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-1 mt-1">
              <button
                onClick={() => setAdding(true)}
                className="flex-1 px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
              >
                {t("mcp.add")}
              </button>
              {/* Rows can change outside this panel (API, another agent, a
                  scoped rebind). Without a refresh the only way to see them was
                  restarting the app. */}
              <button
                type="button"
                onClick={() => void refresh()}
                title={t("mcp.refresh")}
                aria-label={t("mcp.refresh")}
                className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
              >
                ↻
              </button>
            </div>
          )}
      </div>
    </CollapsibleSection>
  );
}
