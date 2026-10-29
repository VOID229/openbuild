// Usage: tokens and cost across the agents on this machine, and their plans' limits (server/usage/).
import { AlertTriangle, ArrowLeft, Check, ChevronDown, Info, Laptop, Layers, RefreshCw, RotateCcw, Ticket } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import claudeSvg from "../assets/brands/claude-color.svg" with { type: "text" };
import grokSvg from "../assets/brands/grok.svg" with { type: "text" };
import openaiSvg from "../assets/brands/openai.svg" with { type: "text" };
import opencodeSvg from "../assets/brands/opencode.svg" with { type: "text" };
import { normalizeResetCredits, USAGE_PROVIDER_NAMES, USAGE_RANGES, type UsageLimits, type UsageLimitsReport, type UsageMachine, type UsageProvider, type UsageRange, type UsageReport, type UsageResetCredits, type UsageResetOutcome, type UsageWindow } from "../../shared/usage";
import { createRedemptionClient } from "../../shared/redemptionClient";
import { useStore } from "../lib/store";
import { cx, useMediaQuery } from "../lib/ui";
import { loadLimits, loadReport, useNow, useUsageLimits, useUsageReport, type UsageScope } from "../lib/usageStats";
import { IconButton, PiMark, Popover, Spinner } from "./primitives";
import { useLightbox } from "./Lightbox";

type Tab = "cost" | "tokens" | "limits";
const RANGE_LABEL: Record<UsageRange, string> = { "24h": "Past 24h", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

// ------------------------------------------------------------------ formatting

const usd = (v: number) => {
  if (v > 0 && v < 0.01) return "<$0.01";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const usdShort = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(v >= 10 ? 0 : 2)}`);
const count = (v: number) => {
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [n, u] of units) if (v >= n) return `${(v / n).toFixed(v / n >= 100 ? 0 : v / n >= 10 ? 1 : 2).replace(/\.0+$/, "")}${u}`;
  return String(Math.round(v));
};
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
function until(t: number, now: number) {
  const mins = Math.max(0, Math.ceil((t - now) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return d ? (h ? `${d}d ${h}h` : `${d}d`) : h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
const ago = (t: number, now: number) => {
  const s = Math.round((now - t) / 1000);
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

// ------------------------------------------------------------------ provider marks

const CURSOR_SVG =
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M11.93 2 3 7.14v9.72L11.93 22l8.93-5.14V7.14L11.93 2Zm0 2.03 6.5 3.75-6.5 3.74-6.5-3.74 6.5-3.75ZM4.86 9.37l6.14 3.53v6.95l-6.14-3.53V9.37Z"/></svg>';
const MARKS: Partial<Record<UsageProvider, string>> = { claude: claudeSvg, codex: openaiSvg, grok: grokSvg, opencode: opencodeSvg, cursor: CURSOR_SVG };

const Mark = memo(function Mark({ provider, size = 16 }: { provider: UsageProvider; size?: number }) {
  if (provider === "pi") return <span className="ustats-mark" style={{ fontSize: size }}><PiMark size={size} /></span>;
  return <span className="ustats-mark" style={{ fontSize: size }} aria-hidden dangerouslySetInnerHTML={{ __html: MARKS[provider] ?? "" }} />;
});

const color = (p: UsageProvider) => `var(--ustats-${p})`;

// ------------------------------------------------------------------ page

export function UsagePage() {
  const [tab, setTab] = useState<Tab>("cost");
  const [range, setRange] = useState<UsageRange>("30d");
  const [machine, setMachine] = useState<UsageScope>("all");
  const report = useUsageReport(range, machine);
  const lim = useUsageLimits();
  const mobile = useMediaQuery("(max-width: 768px)");
  const close = () => useStore.getState().setUsageOpen(false);
  // Escape goes back to the thread/home, like it closes Settings. Leave Escape to whatever is on
  // top (the settings dialog, a lightbox, a menu) and only take it when Usage itself has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (useStore.getState().settingsOpen || useLightbox.getState().open) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && el.closest("[role='menu'], [role='dialog']")) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await (tab === "limits" ? loadLimits(true) : loadReport(range, machine, true));
    } finally {
      setBusy(false);
    }
  };
  // Machines are known from any answer; the last one keeps the picker steady while switching.
  const machines = report.data?.machines ?? lim.data?.machines ?? [];

  return (
    <div className="ustats">
      <header className="ustats-bar">
        {mobile ? (
          <IconButton label="Back" onClick={close}>
            <ArrowLeft size={18} />
          </IconButton>
        ) : null}
        <h1 className="ustats-title">Usage</h1>
        {machines.length > 1 && <MachinePicker machines={machines} value={tab === "limits" ? "all" : machine} onChange={setMachine} disabled={tab === "limits"} />}
        <div className="ustats-controls">
          <div className="ustats-seg" role="tablist" aria-label="View">
            {(["cost", "tokens", "limits"] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className="ustats-seg-btn" onClick={() => setTab(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className={cx("ustats-seg", tab === "limits" && "ustats-seg-off")} role="radiogroup" aria-label="Range" inert={tab === "limits"}>
            {USAGE_RANGES.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={range === r} className="ustats-seg-btn" onClick={() => setRange(r)}>
                {mobile ? r : RANGE_LABEL[r]}
              </button>
            ))}
          </div>
          <IconButton label="Refresh" tooltip="Refresh" onClick={() => void refresh()} disabled={busy} className={cx("ustats-refresh", busy && "ustats-spinning")}>
            <RefreshCw size={15} />
          </IconButton>
        </div>
      </header>
      <div className="ustats-scroll">
        <div className="ustats-body">
          {tab === "limits" ? <LimitsView {...lim} /> : <SpendView tab={tab} {...report} />}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ machines

function MachinePicker({ machines, value, onChange, disabled }: { machines: UsageMachine[]; value: UsageScope; onChange: (m: UsageScope) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const now = useNow(30_000);
  const current = machines.find((m) => m.id === value);
  const dot = (m: UsageMachine) => <span className={cx("ustats-mstate", `ustats-mstate-${m.status}`)} aria-hidden />;
  return (
    <>
      <span className="ustats-crumb" aria-hidden>/</span>
      <button ref={anchor} type="button" className="ustats-machine" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}
        data-tooltip={disabled ? "Limits are per account, from every machine" : undefined} data-tooltip-side="bottom">
        {value === "all" ? "All machines" : current?.name ?? "Machine"}
        <ChevronDown size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu drop-down ustats-mmenu" role="menu" label="Machine" fixed="down">
        <button type="button" role="menuitemradio" aria-checked={value === "all"} className="menu-item" onClick={() => (onChange("all"), setOpen(false))}>
          <Layers size={15} />
          <span className="menu-item-label">All machines</span>
          {value === "all" && <Check size={15} className="menu-check" />}
        </button>
        <div className="menu-sep" />
        {machines.map((m) => (
          <button
            key={m.id}
            type="button"
            role="menuitemradio"
            aria-checked={value === m.id}
            className="menu-item ustats-mitem"
            title={m.status === "error" ? m.error : undefined}
            onClick={() => (onChange(m.id), setOpen(false))}
          >
            <Laptop size={15} />
            <span className="ustats-mtext">
              <span className="ustats-mname">
                {m.name}
                {m.local && <span className="ustats-dim"> · this machine</span>}
              </span>
              <span className={cx("ustats-mnote", m.status === "error" && "ustats-mnote-error")}>
                {m.status === "error" ? (/doesn't report usage/.test(m.error ?? "") ? "Needs an OpenBuild update" : "Unreachable") : m.status === "pending" ? "Reading…" : m.at ? `Updated ${ago(m.at, now)}` : ""}
              </span>
            </span>
            {value === m.id ? <Check size={15} className="menu-check" /> : dot(m)}
          </button>
        ))}
      </Popover>
    </>
  );
}

// ------------------------------------------------------------------ cost and tokens

function SpendView({ tab, data, error }: { tab: "cost" | "tokens"; data?: UsageReport; loading: boolean; error?: string }) {
  const [hidden, setHidden] = useState<Set<UsageProvider>>(new Set());
  if (!data) {
    return error ? <Problem lines={[error]} /> : <div className="ustats-loading"><Spinner size={18} /> Reading transcripts…</div>;
  }
  const cost = tab === "cost";
  const total = cost ? data.totals.cost : data.totals.input + data.totals.cacheRead + data.totals.cacheWrite + data.totals.output;
  const toggle = (p: UsageProvider) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  if (!data.providers.length) {
    return (
      <div className="ustats-empty">
        <p>No usage in this range.</p>
        <p className="ustats-dim">Pi, Claude Code, Codex, Grok, Cursor and OpenCode sessions on this machine show up here.</p>
      </div>
    );
  }
  return (
    <>
      <section className="ustats-top">
        <div className="ustats-summary">
          <div className="ustats-total">{cost ? usd(total) : count(total)}</div>
          <div className="ustats-sub">
            {plural(data.totals.sessions, "session")}
            {cost ? (
              <span className="ustats-hint" data-tooltip="Reported cost where the agent records one, otherwise the tokens at the model's API price, including use covered by a subscription." data-tooltip-side="bottom">
                {" "}· API estimate <Info size={13} />
              </span>
            ) : ` · ${plural(data.totals.requests, "request")}`}
            {error && <span className="ustats-stale"> · couldn't refresh</span>}
          </div>
          <ul className="ustats-providers">
            {data.providers.map((p) => {
              const share = total ? ((cost ? p.cost : p.tokens) / total) * 100 : 0;
              return (
                <li key={p.id}>
                  <button type="button" className={cx("ustats-provider", hidden.has(p.id) && "ustats-provider-off")} aria-pressed={!hidden.has(p.id)} onClick={() => toggle(p.id)} title={hidden.has(p.id) ? "Show in chart" : "Hide from chart"}>
                    <span className="ustats-dot" style={{ background: color(p.id) }} />
                    <Mark provider={p.id} />
                    <span className="ustats-provider-name">{USAGE_PROVIDER_NAMES[p.id]}</span>
                    <span className="ustats-dim ustats-small">{plural(p.sessions, "session")}</span>
                    <span className="ustats-provider-value">{cost ? usd(p.cost) : count(p.tokens)}</span>
                    <span className="ustats-provider-meta ustats-dim">
                      {share.toFixed(1)}% of {cost ? "cost" : "tokens"} · {cost ? `${count(p.tokens)} tokens` : usd(p.cost)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <Chart data={data} metric={tab} hidden={hidden} />
      </section>

      <section className="ustats-section">
        <h2>Totals</h2>
        <div className="ustats-stats">
          <Stat label="Processed tokens" value={count(data.totals.input + data.totals.cacheRead + data.totals.cacheWrite + data.totals.output)} />
          <Stat label="Cached input" value={count(data.totals.cacheRead)} />
          <Stat label="Uncached input" value={count(data.totals.input + data.totals.cacheWrite)} />
          <Stat label="Output" value={count(data.totals.output)} />
          <Stat label="Cache savings" value={usd(data.totals.cacheSavings)} tip="What cached input would have cost at the full input price." />
        </div>
      </section>

      {cost && <CostByType data={data} />}

      <Breakdown data={data} metric={tab} />

      {(data.problems.length > 0 || data.unpriced.length > 0 || data.machines?.some((m) => m.status === "error")) && (
        <Problem
          lines={[
            ...(data.machines ?? []).filter((m) => m.status === "error").map((m) => `${m.name}: ${m.error}${m.at ? " Showing its last numbers." : ""}`),
            ...data.problems.map((p) => `${USAGE_PROVIDER_NAMES[p.provider]}: ${p.message}`),
            ...(data.unpriced.length ? [`No known price for ${data.unpriced.join(", ")}: counted as $0.`] : []),
          ]}
        />
      )}
    </>
  );
}

function Stat({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div className="ustats-stat" data-tooltip={tip} data-tooltip-side="top">
      <div className="ustats-dim">{label}</div>
      <div className="ustats-stat-value">{value}</div>
    </div>
  );
}

const TYPES = [
  ["input", "Input"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
  ["output", "Output"],
  ["other", "Reported"],
] as const;

function CostByType({ data }: { data: UsageReport }) {
  const sum = TYPES.reduce((s, [k]) => s + data.costByType[k], 0) || 1;
  return (
    <section className="ustats-section">
      <h2>Cost by type</h2>
      <div className="ustats-stack">
        {TYPES.map(([k], i) => data.costByType[k] > 0 && <span key={k} className={`ustats-stack-${i}`} style={{ flexGrow: data.costByType[k] / sum }} />)}
      </div>
      <div className="ustats-legend">
        {TYPES.map(([k, label], i) => data.costByType[k] > 0 && (
          <span key={k} data-tooltip={k === "other" ? "Cost an agent reported itself (Cursor, Grok), without a split by token type." : undefined} data-tooltip-side="top">
            <i className={`ustats-stack-${i}`} />
            <span className="ustats-dim">{label}</span> {usd(data.costByType[k])}
          </span>
        ))}
      </div>
    </section>
  );
}

function Breakdown({ data, metric }: { data: UsageReport; metric: "cost" | "tokens" }) {
  const [by, setBy] = useState<"model" | "day">("model");
  const [all, setAll] = useState(false);
  const cost = metric === "cost";
  const rows = useMemo(() => [...data.models].sort((a, b) => (cost ? b.cost - a.cost || b.tokens - a.tokens : b.tokens - a.tokens)), [data, cost]);
  const total = cost ? data.totals.cost : rows.reduce((s, r) => s + r.tokens, 0);
  const top = rows[0] ? (cost ? rows[0].cost : rows[0].tokens) : 0;
  const days = data.days.filter((d) => d.tokens > 0);
  const shown = by === "model" ? rows : days;
  const limit = all ? shown.length : 12;
  const dayFmt = new Intl.DateTimeFormat(undefined, data.bucket === "hour" ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric" });
  return (
    <section className="ustats-section">
      <div className="ustats-section-head">
        <h2>Breakdown</h2>
        <div className="ustats-seg ustats-seg-sm" role="radiogroup" aria-label="Group by">
          {(["model", "day"] as const).map((b) => (
            <button key={b} type="button" role="radio" aria-checked={by === b} className="ustats-seg-btn" onClick={() => setBy(b)}>
              {b === "model" ? "Model" : data.bucket === "hour" ? "Hour" : "Day"}
            </button>
          ))}
        </div>
      </div>
      <table className="ustats-table">
        <thead>
          <tr>
            <th className="ustats-num-col">#</th>
            <th>{by === "model" ? "Model" : data.bucket === "hour" ? "Hour" : "Day"}</th>
            <th className="ustats-r">{by === "model" ? "Requests" : "Sessions"}</th>
            <th className="ustats-r">{cost ? "Cost" : "Tokens"}</th>
            <th className="ustats-r">Share</th>
            <th className="ustats-r">{cost ? "Tokens" : "Cost"}</th>
          </tr>
        </thead>
        <tbody>
          {by === "model"
            ? rows.slice(0, limit).map((r, i) => {
                const v = cost ? r.cost : r.tokens;
                return (
                  <tr key={`${r.provider}:${r.model}`}>
                    <td className="ustats-dim ustats-num-col">{i + 1}</td>
                    <td>
                      <div className="ustats-model">
                        <Mark provider={r.provider} size={14} />
                        <span className="ustats-model-name" title={r.model}>{r.model}</span>
                      </div>
                      <div className="ustats-bar-line" style={{ width: `${top ? Math.max(2, (v / top) * 100) : 0}%`, background: color(r.provider) }} />
                    </td>
                    <td className="ustats-r ustats-dim">{r.requests.toLocaleString()}</td>
                    <td className="ustats-r">{cost ? usd(r.cost) : count(r.tokens)}</td>
                    <td className="ustats-r ustats-dim">{total ? ((v / total) * 100).toFixed(1) : "0.0"}%</td>
                    <td className="ustats-r ustats-dim">{cost ? count(r.tokens) : usd(r.cost)}</td>
                  </tr>
                );
              })
            : days.slice(0, limit).map((d, i) => {
                const v = cost ? d.cost : d.tokens;
                const max = Math.max(...days.map((x) => (cost ? x.cost : x.tokens)));
                return (
                  <tr key={d.t}>
                    <td className="ustats-dim ustats-num-col">{i + 1}</td>
                    <td>
                      <div>{dayFmt.format(d.t)}</div>
                      <div className="ustats-bar-line" style={{ width: `${max ? Math.max(2, (v / max) * 100) : 0}%` }} />
                    </td>
                    <td className="ustats-r ustats-dim">{d.sessions.toLocaleString()}</td>
                    <td className="ustats-r">{cost ? usd(d.cost) : count(d.tokens)}</td>
                    <td className="ustats-r ustats-dim">{total ? ((v / total) * 100).toFixed(1) : "0.0"}%</td>
                    <td className="ustats-r ustats-dim">{cost ? count(d.tokens) : usd(d.cost)}</td>
                  </tr>
                );
              })}
        </tbody>
      </table>
      {shown.length > 12 && (
        <button type="button" className="ustats-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${shown.length}`}
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ chart

const W = 640;
const H = 220;
const PAD = { l: 52, r: 8, t: 10, b: 24 };

/** A smooth path through the points that never overshoots below zero (monotone cubic). */
function smooth(pts: [number, number][]) {
  if (pts.length < 2) return pts.length ? `M${pts[0]![0]},${pts[0]![1]}` : "";
  const n = pts.length;
  const dx = pts.slice(1).map((p, i) => p[0] - pts[i]![0]);
  const m = pts.slice(1).map((p, i) => (p[1] - pts[i]![1]) / dx[i]!);
  const t = pts.map((_, i) => (i === 0 ? m[0]! : i === n - 1 ? m[n - 2]! : m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${pts[i]![0] + h},${pts[i]![1] + t[i]! * h} ${pts[i + 1]![0] - h},${pts[i + 1]![1] - t[i + 1]! * h} ${pts[i + 1]![0]},${pts[i + 1]![1]}`;
  }
  return d;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((s) => s * p >= v) ?? 10) * p;
}

function Chart({ data, metric, hidden }: { data: UsageReport; metric: "cost" | "tokens"; hidden: Set<UsageProvider> }) {
  const [hover, setHover] = useState<number>();
  const box = useRef<SVGSVGElement>(null);
  const cost = metric === "cost";
  const lines = data.providers.map((p, i) => ({ id: p.id, values: data.series.map((b) => (cost ? b.cost[i]! : b.tokens[i]!)) })).filter((l) => !hidden.has(l.id));
  const max = niceMax(Math.max(0, ...lines.flatMap((l) => l.values)));
  const n = data.series.length;
  const x = (i: number) => PAD.l + (n > 1 ? (i / (n - 1)) * (W - PAD.l - PAD.r) : 0);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const fmtY = (v: number) => (cost ? usdShort(v) : count(v));
  const tickFmt = new Intl.DateTimeFormat(undefined, data.bucket === "hour" ? { hour: "numeric" } : { month: "short", day: "numeric" });
  const tipFmt = new Intl.DateTimeFormat(undefined, data.bucket === "hour" ? { weekday: "short", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric" });
  const ticks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  // Draw the biggest series first so the smaller ones stay visible on top.
  const ordered = [...lines].sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0));

  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || n < 2) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.min(n - 1, Math.max(0, Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1)))));
  };
  const h = hover !== undefined ? data.series[hover] : undefined;
  const tipLeft = hover !== undefined ? (x(hover) / W) * 100 : 0;

  return (
    <div className="ustats-chart">
      <div className="ustats-chart-title">{cost ? "Cost" : "Tokens"} per {data.bucket}</div>
      <div className="ustats-chart-box" onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}>
        <svg ref={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="ustats-svg" role="img" aria-label={`${cost ? "Cost" : "Tokens"} per ${data.bucket}`}>
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} className="ustats-grid" />
          ))}
          {ordered.map((l) => {
            const pts = l.values.map((v, i) => [x(i), y(v)] as [number, number]);
            const d = smooth(pts);
            return (
              <g key={l.id} style={{ color: color(l.id) }}>
                <path d={`${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`} className="ustats-area" />
                <path d={d} className="ustats-line" vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
          {hover !== undefined && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="ustats-cursor" vectorEffect="non-scaling-stroke" />}
        </svg>
        <div className="ustats-yaxis">
          {[1, 0.5, 0].map((f) => (
            <span key={f} style={{ top: `${(y(max * f) / H) * 100}%` }}>{fmtY(max * f)}</span>
          ))}
        </div>
        <div className="ustats-xaxis">
          {ticks.map((i) => (
            <span key={i} style={{ left: `${(x(i) / W) * 100}%` }} className={i === 0 ? "ustats-x-first" : i === n - 1 ? "ustats-x-last" : undefined}>
              {tickFmt.format(data.series[i]!.t)}
            </span>
          ))}
        </div>
        {h && (
          <div className={cx("ustats-tip", tipLeft > 60 && "ustats-tip-left")} style={{ left: `${tipLeft}%` }}>
            <div className="ustats-dim">{tipFmt.format(h.t)}</div>
            {data.providers.map((p, i) => !hidden.has(p.id) && (
              <div key={p.id} className="ustats-tip-row">
                <Mark provider={p.id} size={13} />
                <span className="ustats-dim">{USAGE_PROVIDER_NAMES[p.id]}</span>
                <span>{cost ? usd(h.cost[i]!) : count(h.tokens[i]!)}</span>
              </div>
            ))}
            <div className="ustats-tip-row ustats-tip-total">
              <span />
              <span className="ustats-dim">Total</span>
              <span>{cost ? usd(h.cost.reduce((s, v, i) => s + (hidden.has(data.providers[i]!.id) ? 0 : v), 0)) : count(h.tokens.reduce((s, v, i) => s + (hidden.has(data.providers[i]!.id) ? 0 : v), 0))}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ limits

function LimitsView({ data, error }: { data?: UsageLimitsReport; error?: string; loading: boolean }) {
  const now = useNow(30_000);
  if (!data) return error ? <Problem lines={[error]} /> : <div className="ustats-loading"><Spinner size={18} /> Asking providers…</div>;
  const ok = data.providers.filter((p) => p.windows.length);
  const failed = data.providers.filter((p) => p.error);
  if (!data.providers.length) {
    return (
      <div className="ustats-empty">
        <p>No plan sign-ins found.</p>
        <p className="ustats-dim">Limits show for Claude Code, Codex, Grok and Cursor when they're signed in with a subscription on this machine.</p>
      </div>
    );
  }
  return (
    <>
      {ok.map((p) => (
        <section key={p.id} className="ustats-limit-group">
          <h2 className="ustats-limit-head">
            <Mark provider={p.provider} size={18} />
            {USAGE_PROVIDER_NAMES[p.provider]}
            {p.account && <span className="ustats-account">{p.account}</span>}
            {p.plan && <span className="ustats-plan">{p.plan}</span>}
            {(p.source || p.machine) && (data.machines?.length ?? 0) + (p.account ? 1 : 0) > 1 && (
              <span className="ustats-dim ustats-small ustats-source">{[p.machine, p.source].filter(Boolean).join(" · ")}</span>
            )}
            {p.stale && <span className="ustats-dim ustats-small">as of {ago(p.asOf, now)}</span>}
          </h2>
          {p.windows.map((w) => <LimitRow key={w.id} account={p} w={w} now={now} />)}
        </section>
      ))}
      {(failed.length > 0 || data.machines?.some((m) => m.status === "error")) && (
        <Problem
          lines={[
            ...(data.machines ?? []).filter((m) => m.status === "error").map((m) => `${m.name}: ${m.error}`),
            ...failed.map((p) => `${p.machine ? `${p.machine} · ` : ""}${USAGE_PROVIDER_NAMES[p.provider]}${p.account ? ` ${p.account}` : ""}${p.source ? ` (${p.source})` : ""}: ${p.error}`),
          ]}
        />
      )}
      <p className="ustats-foot ustats-dim">
        Checked {ago(data.checkedAt, now)}
      </p>
    </>
  );
}

/** Where the window's use is headed by its reset, at the pace so far. */
function pace(w: UsageWindow, now: number) {
  if (!w.resetsAt || !w.windowMins) return;
  const elapsed = 1 - (w.resetsAt - now) / (w.windowMins * 60_000);
  if (elapsed <= 0.05 || elapsed > 1 || w.usedPercent >= 100) return;
  return w.usedPercent / elapsed;
}

/** The share of the window still ahead, which is what even spending would leave. */
function evenPace(w: UsageWindow, now: number) {
  if (!w.resetsAt || !w.windowMins) return;
  const left = (w.resetsAt - now) / (w.windowMins * 60_000);
  if (left < 0 || left > 1) return;
  return Math.round(left * 100);
}

const RESET_OUTCOMES: Record<UsageResetOutcome, string> = {
  reset: "Reset applied. These limits have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No banked reset is available now.",
  alreadyRedeemed: "That reset was already used.",
};

const resetClient = createRedemptionClient(() => window.localStorage, async (body) => {
  const res = await fetch("/api/usage/limits/reset", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error",
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result?.error || `The reset failed (HTTP ${res.status}).`);
  if (!(result?.outcome in RESET_OUTCOMES)) throw new Error("Unrecognized reset response.");
  void loadLimits(true);
  return result;
}, () => crypto.randomUUID());

const creditsNote = (credits: UsageResetCredits, now: number) => {
  const expires = credits.expiresAt ? ` · expires in ${until(credits.expiresAt, now)}` : "";
  return `${credits.available} banked${expires}`;
};

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ustats-limit-row">
      <span className="ustats-dim">{label}</span>
      <span>{children}</span>
    </div>
  );
}

/** What a clicked limit bar shows, and the one place a banked reset can be spent. */
function LimitDetails({ account, w, now, onClose }: { account: UsageLimits; w: UsageWindow; now: number; onClose: () => void }) {
  const credits = normalizeResetCredits(account.resetCredits);
  const left = Math.max(0, 100 - w.usedPercent);
  const timeLeft = evenPace(w, now);
  const [confirming, setConfirming] = useState(false);
  const state = useSyncExternalStore(resetClient.subscribe, () => resetClient.snapshot(account.id));
  const busy = state.busy;
  const status = state.error ?? (state.result ? state.result.warning ?? RESET_OUTCOMES[state.result.outcome] : undefined);
  const plan = account.plan?.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const useReset = async () => {
    setConfirming(false);
    await resetClient.run(account.id, account.machineId);
  };
  return (
    <div className="ustats-limit-pop-in">
      <div className="ustats-limit-pop-head">
        <Mark provider={account.provider} size={18} />
        <span className="ustats-limit-pop-name">{USAGE_PROVIDER_NAMES[account.provider]}</span>
        {account.account && <span className="ustats-account">{account.account}</span>}
      </div>
      {account.source && <div className="ustats-limit-pop-source">{account.source}</div>}
      {(plan || account.machine) && (
        <div className="ustats-limit-pop-group">
          {plan && <DetailRow label="Plan">{plan}</DetailRow>}
          <DetailRow label="Signed in">{account.machine ?? "this machine"}</DetailRow>
        </div>
      )}
      <div className="ustats-limit-pop-group">
        <DetailRow label="Left">{Math.round(left)}%</DetailRow>
        {w.resetsAt && (
          <DetailRow label="Resets">
            {new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            <span className="ustats-dim"> · in {until(w.resetsAt, now)}</span>
          </DetailRow>
        )}
        {timeLeft !== undefined && <DetailRow label="Even pace">{timeLeft}% left by now</DetailRow>}
        {w.windowMins && <DetailRow label="Window">{w.windowMins >= 1440 ? `${Math.round(w.windowMins / 1440)} days` : `${Math.round(w.windowMins / 60)} hours`}</DetailRow>}
      </div>
      {(credits?.available || status) ? (
        <div className="ustats-limit-pop-reset">
          {credits?.available ? (
            confirming ? (
              <div className="ustats-limit-confirm">
                <span>Use one banked reset? This clears the current limits and can’t be undone.</span>
                <div className="ustats-limit-confirm-actions">
                  <button type="button" className="ustats-limit-cancel" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
                  <button type="button" className="ustats-limit-reset" onClick={() => void useReset()} disabled={busy || !!state.result}>{busy ? "Using…" : "Use reset"}</button>
                </div>
              </div>
            ) : (
              <div className="ustats-limit-banked">
                <span><Ticket size={12} /> {creditsNote(credits, now)}</span>
                <button type="button" className="ustats-limit-reset" onClick={() => setConfirming(true)} disabled={busy || !!state.result}>{busy ? "Using…" : state.error ? "Retry reset" : "Use reset"}</button>
              </div>
            )
          ) : null}
          {status && <div className="ustats-limit-reset-status" role="status">{status}</div>}
          {status && <button type="button" className="ustats-limit-done" onClick={onClose}>Close</button>}
        </div>
      ) : null}
    </div>
  );
}

function LimitRow({ account, w, now }: { account: UsageLimits; w: UsageWindow; now: number }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const left = Math.max(0, 100 - w.usedPercent);
  const projected = pace(w, now);
  const credits = normalizeResetCredits(account.resetCredits);
  const level = w.usedPercent >= 90 ? "danger" : w.usedPercent >= 70 ? "warn" : "ok";
  const trend = projected === undefined ? undefined : projected > 100 ? "Runs out before it resets at this pace" : `At this pace, about ${Math.round(100 - projected)}% will be left when it resets`;
  return (
    <div className="ustats-limit">
      <div className="ustats-limit-label">
        <div>{w.label}</div>
        <div className="ustats-limit-big">
          {Math.round(left)}%<span className="ustats-dim"> left</span>
        </div>
        {w.limitUsd !== undefined && w.usedUsd !== undefined && <div className="ustats-dim ustats-small">{usd(w.usedUsd)} of {usd(w.limitUsd)}</div>}
      </div>
      <div
        ref={anchor}
        className="ustats-limit-track"
        data-level={level}
        style={{ ["--c" as string]: color(account.provider) }}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${w.label}: ${Math.round(left)}% left. Show details${credits?.available ? ` and ${credits.available} banked reset${credits.available === 1 ? "" : "s"}` : ""}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <div className="ustats-limit-fill" style={{ width: `${left}%` }}>
          {left >= 8 && <span>{Math.round(left)}%</span>}
        </div>
        {projected !== undefined && projected <= 100 && (
          <div className="ustats-limit-pace" style={{ left: `${Math.max(0, 100 - projected)}%` }} data-tooltip={trend} data-tooltip-side="top" />
        )}
        <div className="ustats-limit-meta">
          {w.resetsAt && (
            <span data-tooltip={`Resets ${new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`} data-tooltip-side="top">
              <RotateCcw size={11} /> {until(w.resetsAt, now)}
            </span>
          )}
          {!!credits?.available && (
            <span data-tooltip={`${credits.available} banked reset${credits.available === 1 ? "" : "s"}`} data-tooltip-side="top">
              <Ticket size={11} /> {credits.available}
            </span>
          )}
        </div>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="ustats-limit-pop" label={`${USAGE_PROVIDER_NAMES[account.provider]} ${w.label}`} fixed="auto" align="start">
        <LimitDetails account={account} w={w} now={now} onClose={() => setOpen(false)} />
      </Popover>
      {w.usedPercent >= 100 ? (
        <div className="ustats-limit-warn"><AlertTriangle size={12} /> Limit reached{w.resetsAt ? ` · back in ${until(w.resetsAt, now)}` : ""}</div>
      ) : projected !== undefined && projected > 100 ? (
        <div className="ustats-limit-warn"><AlertTriangle size={12} /> {trend}</div>
      ) : null}
    </div>
  );
}

function Problem({ lines }: { lines: string[] }) {
  return (
    <div className="ustats-problem" role="status">
      <AlertTriangle size={15} />
      <div>{lines.map((l) => <div key={l}>{l}</div>)}</div>
    </div>
  );
}
