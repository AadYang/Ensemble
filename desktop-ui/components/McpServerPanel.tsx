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

const STDIO_TEMPLATE = `{
  "command": "node",
  "args": ["./mcp-server.js"],
  "env": {}
}`;
const HTTP_TEMPLATE = `{
  "url": "http://localhost:8080/mcp",
  "headers": {}
}`;

export function McpServerPanel() {
  const [servers, setServers] = useState<McpServerDTO[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [name, setName] = useState("");
  const [configText, setConfigText] = useState(STDIO_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const refresh = async () => {
    try {
      const list = await listMcpServers();
      setServers(list);
    } catch (err) {
      console.warn("listMcpServers failed", err);
    }
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
    <div className="border-b border-[var(--border)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-3 py-2 flex items-center gap-2 text-xs hover:bg-[var(--bg-pane)]"
      >
        <span className="text-[var(--text-faint)]">{open ? "▾" : "▸"}</span>
        <span className="text-[var(--text-dim)] tracking-wider">{t("mcp.label")}</span>
        <span className="text-[var(--text-faint)] ml-auto">
          {servers.filter((s) => s.enabled).length}/{servers.length}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-1 text-[11px]">
          {servers.length === 0 && (
            <div className="px-2 py-1 text-[var(--text-faint)]">{t("mcp.empty")}</div>
          )}
          {servers.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-1 px-1 py-0.5 border border-[var(--border)] bg-[var(--bg-pane)]"
            >
              <span className={`status-dot ${s.enabled ? "running" : "idle"}`} />
              <span className="truncate flex-1" title={`${s.transport}`}>
                {s.name}
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
            <button
              onClick={() => setAdding(true)}
              className="px-2 py-0.5 mt-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
            >
              {t("mcp.add")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
