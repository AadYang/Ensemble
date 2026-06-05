"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchUsageSummary, type UsageSummary } from "@/lib/usage-api";
import { useT } from "@/i18n/useT";

// W17: token usage stats dialog.

type Range = "7d" | "30d" | "90d" | "all";
type GroupBy = "day" | "agent" | "model" | "provider";
type ChartMetric = "total" | "breakdown";

// Series rendered in "breakdown" mode. Order = stack order from bottom up.
const TOKEN_SERIES = [
  { key: "input", color: "#00d9ff" },
  { key: "output", color: "#d4863e" },
  { key: "cacheRead", color: "#7c9c5e" },
  { key: "cacheWrite", color: "#b86a8a" },
] as const;

const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

function rangeSince(r: Range): string | undefined {
  if (r === "all") return undefined;
  const days = r === "7d" ? 7 : r === "30d" ? 30 : 90;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return since.toISOString();
}

function fmtToken(n: number): string {
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtUSD(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Props {
  onClose: () => void;
  onNavigateAgent?: (agentId: string) => void;
  onOpenPricing?: (model?: string) => void;
  refreshKey?: number;
}

export function UsageStatsDialog({ onClose, onNavigateAgent, onOpenPricing, refreshKey = 0 }: Props) {
  const t = useT();
  const [range, setRange] = useState<Range>("30d");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [includeDescendants, setIncludeDescendants] = useState(false);
  const [chartMode, setChartMode] = useState<"area" | "line">("area");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("total");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchUsageSummary({
      since: rangeSince(range),
      until: new Date().toISOString(),
      tz: TZ,
      includeDescendants: groupBy === "agent" && includeDescendants,
    })
      .then((s) => {
        if (alive) setData(s);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range, groupBy, includeDescendants, refreshKey]);

  const chartRows = useMemo(() => {
    return (data?.daily ?? []).map((d) => ({
      date: d.date,
      input: d.inputTokens,
      output: d.outputTokens,
      cacheRead: d.cacheReadTokens,
      cacheWrite: d.cacheCreationTokens,
      total: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens,
    }));
  }, [data]);

  const seriesLabel = (k: string): string => {
    switch (k) {
      case "input": return t("usage.token.input");
      case "output": return t("usage.token.output");
      case "cacheRead": return t("usage.token.cacheRead");
      case "cacheWrite": return t("usage.token.cacheWrite");
      case "total": return t("usage.token.total");
      default: return k;
    }
  };

  const onExportCsv = () => {
    if (!data) return;
    const rangeLabel = range === "all" ? "all" : range;
    let csv = "";
    let filename = "";
    if (groupBy === "day") {
      filename = `usage-daily-${rangeLabel}.csv`;
      csv = "date,costUSD,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,turns\n";
      for (const d of data.daily) {
        csv += `${d.date},${d.costUSD.toFixed(6)},${d.inputTokens},${d.outputTokens},${d.cacheReadTokens},${d.cacheCreationTokens},${d.turns}\n`;
      }
    } else if (groupBy === "agent") {
      filename = `usage-by-agent-${rangeLabel}.csv`;
      csv = "agentId,agentName,parentId,costUSD,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,turns,includesDescendants\n";
      for (const a of data.byAgent) {
        csv += `${a.agentId ?? ""},"${a.agentName.replace(/"/g, '""')}",${a.parentId ?? ""},${a.costUSD.toFixed(6)},${a.inputTokens},${a.outputTokens},${a.cacheReadTokens},${a.cacheCreationTokens},${a.turns},${includeDescendants}\n`;
      }
    } else if (groupBy === "model") {
      filename = `usage-by-model-${rangeLabel}.csv`;
      csv = "model,costUSD,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,turns\n";
      for (const m of data.byModel) {
        csv += `${m.model},${m.costUSD.toFixed(6)},${m.inputTokens},${m.outputTokens},${m.cacheReadTokens},${m.cacheCreationTokens},${m.turns}\n`;
      }
    } else {
      filename = `usage-by-provider-${rangeLabel}.csv`;
      csv = "providerId,providerName,kind,costUSD,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,turns\n";
      for (const p of data.byProvider) {
        csv += `${p.providerId ?? ""},"${p.providerName.replace(/"/g, '""')}",${p.kind},${p.costUSD.toFixed(6)},${p.inputTokens},${p.outputTokens},${p.cacheReadTokens},${p.cacheCreationTokens},${p.turns}\n`;
      }
    }
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/70 backdrop-blur-sm p-6">
      <div className="tool-card flex w-full max-w-5xl max-h-[calc(100dvh-3rem)] flex-col overflow-hidden bg-[var(--bg-elevated)]">
        <div className="flex shrink-0 items-center gap-2 mb-3 text-xs">
          <span className="text-[var(--accent)] tracking-wider">{t("usage.title")}</span>
          <span className="text-[var(--text-faint)]">{t("usage.tzLabel")} {TZ}</span>
          <span className="flex-1" />
          {onOpenPricing && (
            <button
              onClick={() => onOpenPricing()}
              className="px-2 py-0.5 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
            >
              pricing
            </button>
          )}
          <button
            onClick={onClose}
            className="px-1.5 py-0.5 text-[var(--text-dim)] hover:text-[var(--err)] hover:border-[var(--err)] border border-[var(--border)] transition-colors"
          >
            ✕
          </button>
        </div>

        {/* range buttons */}
        <div className="flex shrink-0 items-center gap-1 mb-3 text-xs">
          <span className="text-[var(--text-faint)] mr-1">{t("usage.range")}:</span>
          {(["7d", "30d", "90d", "all"] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 border ${
                range === r
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
              } transition-colors`}
              title={r === "all" ? t("usage.range.allTip") : undefined}
            >
              {r === "all" ? t("usage.range.all") : r}
            </button>
          ))}
        </div>

        {/* stat cards */}
        <div className="grid shrink-0 grid-cols-4 gap-2 mb-3">
          <StatCard label={t("usage.card.totalCost")} value={data ? fmtUSD(data.totals.costUSD) : "—"} />
          <StatCard label={t("usage.card.agents")} value={data ? String(data.totals.agents) : "—"} />
          <StatCard label={t("usage.card.turns")} value={data ? String(data.totals.turns) : "—"} />
          <StatCard
            label={t("usage.card.topAgent")}
            value={data?.topAgent ? data.topAgent.agentName : "—"}
            sub={data?.topAgent ? fmtUSD(data.topAgent.costUSD) : undefined}
            onClick={
              data?.topAgent?.agentId && onNavigateAgent
                ? () => onNavigateAgent(data.topAgent!.agentId!)
                : undefined
            }
          />
        </div>

        {/* trend chart */}
        <div className="shrink-0 border border-[var(--border)] bg-[var(--bg-pane)] p-2 mb-3">
          <div className="flex items-center gap-2 text-[10px] text-[var(--text-faint)] mb-1">
            <span>{t("usage.trend")}</span>
            <span className="flex-1" />
            <button
              onClick={() => setChartMetric("total")}
              className={`px-1.5 py-0.5 border ${chartMetric === "total" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-dim)]"}`}
              title={t("usage.metric.total.tip")}
            >
              {t("usage.metric.total")}
            </button>
            <button
              onClick={() => setChartMetric("breakdown")}
              className={`px-1.5 py-0.5 border ${chartMetric === "breakdown" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-dim)]"}`}
              title={t("usage.metric.breakdown.tip")}
            >
              {t("usage.metric.breakdown")}
            </button>
            <span className="mx-1 text-[var(--border)]">|</span>
            <button
              onClick={() => setChartMode("area")}
              className={`px-1.5 py-0.5 border ${chartMode === "area" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-dim)]"}`}
            >
              area
            </button>
            <button
              onClick={() => setChartMode("line")}
              className={`px-1.5 py-0.5 border ${chartMode === "line" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-dim)]"}`}
            >
              line
            </button>
          </div>
          {loading && !data ? (
            <div className="h-40 flex items-center justify-center text-[var(--text-faint)] text-xs">{t("usage.loading")}</div>
          ) : (data?.daily.length ?? 0) === 0 ? (
            <div className="h-40 flex items-center justify-center text-[var(--text-faint)] text-xs">{t("usage.emptyChart")}</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              {chartMode === "area" ? (
                <AreaChart data={chartRows}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-faint)" }} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-faint)" }} tickFormatter={(v) => fmtToken(Number(v))} />
                  <Tooltip
                    contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", fontSize: 11 }}
                    formatter={(v, name) => [fmtToken(Number(v)), seriesLabel(String(name))]}
                  />
                  {chartMetric === "total" ? (
                    <Area
                      type="monotone"
                      dataKey="total"
                      name="total"
                      stroke="var(--accent)"
                      fill="var(--accent)"
                      fillOpacity={0.35}
                    />
                  ) : (
                    TOKEN_SERIES.map((s) => (
                      <Area
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        name={s.key}
                        stackId="tokens"
                        stroke={s.color}
                        fill={s.color}
                        fillOpacity={0.45}
                      />
                    ))
                  )}
                </AreaChart>
              ) : (
                <LineChart data={chartRows}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--text-faint)" }} />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-faint)" }} tickFormatter={(v) => fmtToken(Number(v))} />
                  <Tooltip
                    contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", fontSize: 11 }}
                    formatter={(v, name) => [fmtToken(Number(v)), seriesLabel(String(name))]}
                  />
                  {chartMetric === "total" ? (
                    <Line type="monotone" dataKey="total" name="total" stroke="var(--accent)" dot={false} strokeWidth={1.5} />
                  ) : (
                    TOKEN_SERIES.map((s) => (
                      <Line key={s.key} type="monotone" dataKey={s.key} name={s.key} stroke={s.color} dot={false} />
                    ))
                  )}
                </LineChart>
              )}
            </ResponsiveContainer>
          )}
          <div className="flex gap-3 mt-1 text-[10px] text-[var(--text-faint)]">
            {chartMetric === "total" ? (
              <span className="flex items-center gap-1">
                <span style={{ background: "var(--accent)" }} className="w-2 h-2 inline-block" />
                {t("usage.token.total")}
              </span>
            ) : (
              TOKEN_SERIES.map((s) => (
                <span key={s.key} className="flex items-center gap-1">
                  <span style={{ background: s.color }} className="w-2 h-2 inline-block" />
                  {seriesLabel(s.key)}
                </span>
              ))
            )}
          </div>
        </div>

        {/* groupBy + detail */}
        <div className="flex shrink-0 items-center gap-1 mb-2 text-xs">
          <span className="text-[var(--text-faint)] mr-1">{t("usage.groupBy")}:</span>
          {(["day", "agent", "model", "provider"] as GroupBy[]).map((g) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={`px-2 py-0.5 border ${
                groupBy === g
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
              } transition-colors`}
            >
              {g}
            </button>
          ))}
          {groupBy === "agent" && (
            <label className="ml-2 flex items-center gap-1 text-[10px] text-[var(--text-dim)]">
              <input
                type="checkbox"
                checked={includeDescendants}
                onChange={(e) => setIncludeDescendants(e.target.checked)}
              />
              {t("usage.includeDescendants")}
            </label>
          )}
        </div>

        <DetailTable data={data} groupBy={groupBy} loading={loading} t={t} onOpenPricing={onOpenPricing} />

        {error && (
          <div className="text-[var(--err)] text-[10px] mt-2">{error}</div>
        )}

        <div className="flex shrink-0 items-center gap-2 mt-3 text-xs">
          <span className="flex-1" />
          <button
            onClick={onExportCsv}
            disabled={!data}
            className="px-3 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors disabled:opacity-30"
          >
            {t("usage.exportCsv")}
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1 border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {t("usage.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, onClick }: {
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <button
      onClick={onClick}
      disabled={!clickable}
      className={`text-left border border-[var(--border)] bg-[var(--bg-pane)] p-2 ${
        clickable ? "hover:border-[var(--accent)] transition-colors cursor-pointer" : "cursor-default"
      }`}
    >
      <div className="text-[10px] text-[var(--text-faint)] tracking-wider mb-1">{label}</div>
      <div className="text-base text-[var(--text)] font-bold">{value}</div>
      {sub && <div className="text-[10px] text-[var(--accent)]">{sub}</div>}
    </button>
  );
}

function DetailTable({
  data,
  groupBy,
  loading,
  t,
  onOpenPricing,
}: {
  data: UsageSummary | null;
  groupBy: GroupBy;
  loading: boolean;
  t: (k: string, p?: Record<string, string | number>) => string;
  onOpenPricing?: (model?: string) => void;
}) {
  if (loading && !data) {
    return (
      <div className="min-h-0 flex-1 flex items-center justify-center text-[var(--text-faint)] text-xs">
        {t("usage.loading")}
      </div>
    );
  }
  if (!data) return null;

  const rowsRaw: Array<{
    label: string;
    sub?: string;
    indent?: number;
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    inputLocal: number;
    outputLocal: number;
    turnsWithLocal: number;
    turns: number;
  }> = [];

  if (groupBy === "day") {
    for (const d of data.daily) {
      rowsRaw.push({
        label: d.date,
        cost: d.costUSD,
        input: d.inputTokens,
        output: d.outputTokens,
        cacheRead: d.cacheReadTokens,
        cacheCreation: d.cacheCreationTokens,
        inputLocal: d.inputTokensLocal,
        outputLocal: d.outputTokensLocal,
        turnsWithLocal: d.turnsWithLocal,
        turns: d.turns,
      });
    }
  } else if (groupBy === "agent") {
    for (const a of data.byAgent) {
      const isDeleted = a.agentId === null;
      rowsRaw.push({
        label: isDeleted ? `(deleted) ${a.agentName}` : a.agentName,
        sub: a.parentId ? `↳ parent ${a.parentId.slice(0, 8)}` : undefined,
        indent: a.parentId ? 1 : 0,
        cost: a.costUSD,
        input: a.inputTokens,
        output: a.outputTokens,
        cacheRead: a.cacheReadTokens,
        cacheCreation: a.cacheCreationTokens,
        inputLocal: a.inputTokensLocal,
        outputLocal: a.outputTokensLocal,
        turnsWithLocal: a.turnsWithLocal,
        turns: a.turns,
      });
    }
  } else if (groupBy === "model") {
    for (const m of data.byModel) {
      rowsRaw.push({
        label: m.model,
        cost: m.costUSD,
        input: m.inputTokens,
        output: m.outputTokens,
        cacheRead: m.cacheReadTokens,
        cacheCreation: m.cacheCreationTokens,
        inputLocal: m.inputTokensLocal,
        outputLocal: m.outputTokensLocal,
        turnsWithLocal: m.turnsWithLocal,
        turns: m.turns,
      });
    }
  } else {
    for (const p of data.byProvider) {
      const isDeleted = p.providerId === null;
      rowsRaw.push({
        label: isDeleted ? `(deleted) ${p.providerName}` : `${p.providerName} · ${p.kind}`,
        cost: p.costUSD,
        input: p.inputTokens,
        output: p.outputTokens,
        cacheRead: p.cacheReadTokens,
        cacheCreation: p.cacheCreationTokens,
        inputLocal: p.inputTokensLocal,
        outputLocal: p.outputTokensLocal,
        turnsWithLocal: p.turnsWithLocal,
        turns: p.turns,
      });
    }
  }

  if (rowsRaw.length === 0) {
    return (
      <div className="min-h-24 flex-1 flex items-center justify-center text-[var(--text-faint)] text-xs border border-[var(--border)]">
        {t("usage.emptyTable")}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto border border-[var(--border)]">
      <table className="w-full text-xs">
        <thead className="bg-[var(--bg-pane)] text-[var(--text-faint)] sticky top-0">
          <tr>
            <th className="text-left px-2 py-1 font-normal tracking-wider">{t("usage.col.label")}</th>
            <th className="text-right px-2 py-1 font-normal tracking-wider">{t("usage.col.cost")}</th>
            <th className="text-right px-2 py-1 font-normal tracking-wider">in</th>
            <th className="text-right px-2 py-1 font-normal tracking-wider">out</th>
            <th className="text-right px-2 py-1 font-normal tracking-wider">cache_r</th>
            <th className="text-right px-2 py-1 font-normal tracking-wider">cache_w</th>
            <th className="text-right px-2 py-1 font-normal tracking-wider" title={t("usage.col.audit.tip")}>
              {t("usage.col.audit")}
            </th>
            <th className="text-right px-2 py-1 font-normal tracking-wider">turns</th>
          </tr>
        </thead>
        <tbody>
          {rowsRaw.map((r, i) => {
            const upstreamTotal = r.input + r.output;
            const localTotal = r.inputLocal + r.outputLocal;
            const hasAudit = r.turnsWithLocal > 0 && localTotal > 0;
            const ratio = hasAudit ? upstreamTotal / localTotal : null;
            // Color: gray below 30% drift, yellow 30-100%, red >2x.
            const auditColor = ratio == null
              ? "text-[var(--text-faint)]"
              : ratio >= 2 || ratio <= 0.5
                ? "text-[var(--err)]"
                : ratio >= 1.3 || ratio <= 0.7
                  ? "text-[var(--warn)]"
                  : "text-[var(--text-dim)]";
            const auditText = ratio == null
              ? "—"
              : `${ratio.toFixed(2)}×`;
            const auditTitle = hasAudit
              ? `upstream ${fmtToken(upstreamTotal)} vs local ${fmtToken(localTotal)} (${r.turnsWithLocal}/${r.turns} turns audited)`
              : t("usage.col.audit.none");
            return (
              <tr key={i} className="border-t border-[var(--border)] hover:bg-[var(--bg-pane)]">
                <td className="px-2 py-1" style={{ paddingLeft: 8 + (r.indent ?? 0) * 16 }}>
                  {(r.indent ?? 0) > 0 && <span className="text-[var(--text-faint)]">↳ </span>}
                  {r.label}
                  {r.sub && <span className="text-[10px] text-[var(--text-faint)] ml-2">{r.sub}</span>}
                </td>
                <td className="text-right px-2 py-1 text-[var(--accent)]">{fmtUSD(r.cost)}</td>
                <td className="text-right px-2 py-1">{fmtToken(r.input)}</td>
                <td className="text-right px-2 py-1">{fmtToken(r.output)}</td>
                <td className="text-right px-2 py-1">{fmtToken(r.cacheRead)}</td>
                <td className="text-right px-2 py-1">{fmtToken(r.cacheCreation)}</td>
                <td className={`text-right px-2 py-1 ${auditColor}`} title={auditTitle}>
                  {auditText}
                </td>
                <td className="text-right px-2 py-1 text-[var(--text-dim)]">{r.turns}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.unknownModels.length > 0 && (
        <div className="flex items-center gap-2 border-t border-[var(--warn)] px-2 py-1 text-[10px] text-[var(--warn)] bg-[var(--bg-pane)]">
          <span className="min-w-0 flex-1 truncate">
            {data.unknownModels.length} unknown model(s) (no price configured): {data.unknownModels.map((u) => u.model).join(", ")}
          </span>
          {onOpenPricing && (
            <button
              onClick={() => onOpenPricing(data.unknownModels[0]?.model)}
              className="shrink-0 px-2 py-0.5 border border-[var(--warn)] hover:bg-[var(--warn)] hover:text-black"
            >
              set price
            </button>
          )}
        </div>
      )}
    </div>
  );
}
