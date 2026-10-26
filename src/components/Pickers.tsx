import { Check, KeyRound, Search, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  EFFORTS,
  nearestEffort,
  type Effort,
  type ModelInfo,
  type PlanId,
} from "../../shared/types";
import { findModel, isAuto, providerName, providerOf } from "../lib/models";
import { usePlugins } from "../lib/plugins";
import { hasModelScope, providerGroups, scopedModels, searchProviderGroups } from "../lib/modelSearch";
import { composerEffort, selectionFor, useStore } from "../lib/store";
import type { Detection } from "../lib/types";
import { effortFor } from "../lib/effort";
import { arrowNav, cx, useDevicePref } from "../lib/ui";
import { Popover, ProviderIcon, Spinner } from "./primitives";

const SHORT: Record<Effort, string> = {
  off: "off",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};
const LONG: Record<Effort, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** A paired device's list before it arrives: the picker says it's asking, not "no models". */
const PENDING: Detection = { plan: "pi", status: "checking", models: [] };
const STALE_MODELS = 10 * 60 * 1000;

/**
 * The models the composer can use: this server's, or those of the paired device the thread works
 * on (fetched once its first turn needs them, and re-asked when they're old).
 */
function useDeviceDetection(deviceId?: string): Partial<Record<PlanId, Detection>> {
  const local = useStore((s) => s.detection);
  const remote = useStore((s) => (deviceId ? s.remoteModels[deviceId] : undefined));
  const load = useStore((s) => s.loadDeviceModels);
  const detection = useMemo(
    () => (deviceId ? { pi: remote ?? PENDING } : local),
    [deviceId, remote, local],
  );
  useEffect(() => {
    if (!deviceId) return;
    const stale =
      remote &&
      remote.status !== "checking" &&
      Date.now() - (remote.checkedAt ?? 0) > STALE_MODELS;
    if (!remote || stale) void load(deviceId, !!remote);
  }, [deviceId, remote, load]);
  return detection;
}

export function EffortPicker({ dropUp, deviceId }: { dropUp: boolean; deviceId?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const effort = useStore(composerEffort);
  const selection = useStore(selectionFor);
  const detection = useDeviceDetection(deviceId);
  const setEffort = useStore((s) => s.setEffort);

  const auto = isAuto(selection);
  const model = auto ? undefined : findModel(detection, selection);
  // Availability comes from the model's metadata; the auto router applies the level wherever supported.
  const levels: Effort[] = auto
    ? [...EFFORTS]
    : (model?.reasoning.efforts ?? []);
  const supported = levels.length > 0;
  const shown = nearestEffort(levels, effort) ?? effort;
  // Toggle-only models (thinking on/off, no levels): "medium" means "on, at the model's default".
  const onOff =
    !!model && model.reasoning.mode === "none" && model.reasoning.toggle;
  const labelOf = (e: Effort, short: boolean) =>
    onOff && e === "medium"
      ? short
        ? "on"
        : "On"
      : short
        ? SHORT[e]
        : LONG[e];
  const tooltip =
    !model && !auto
      ? "Select a model first"
      : !supported
        ? `${model?.name} uses its default reasoning`
        : "Reasoning effort";

  return (
    <div className="picker">
      <button
        ref={anchor}
        type="button"
        className={cx("pill pill-plain", open && "pill-open")}
        // aria-disabled (not disabled) keeps hover working so the tooltip can explain why.
        aria-disabled={!supported}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={open ? undefined : tooltip}
        data-tooltip-side={dropUp ? "top" : "bottom"}
        onClick={() => supported && setOpen((o) => !o)}
      >
        {supported ? labelOf(shown, false) : "Default"}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        className="menu effort-menu"
        role="listbox"
        label="Reasoning effort"
        // Portaled and flipped to whichever side has room, so it never runs off the screen.
        fixed={dropUp ? "up" : "auto"}
      >
        <div className="menu-label">Thinking level</div>
        <div onKeyDown={(e) => arrowNav(e)}>
          {EFFORTS.map((level) => {
            const enabled = levels.includes(level);
            return (
              <button
                key={level}
                type="button"
                role="option"
                aria-selected={shown === level}
                className="menu-item"
                disabled={!enabled}
                title={
                  enabled
                    ? undefined
                    : `Not supported by ${model?.name ?? "this model"}`
                }
                onClick={() => {
                  setEffort(level);
                  setOpen(false);
                }}
              >
                <span className="menu-item-label">{labelOf(level, true)}</span>
                {shown === level && <Check size={15} className="menu-check" />}
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

/** Why there are no models to pick: Pi missing, not signed in anywhere, or not answering. */
function PiStatus({ detection }: { detection: Partial<Record<PlanId, Detection>> }) {
  const d = detection.pi;
  const openSettings = useStore((s) => s.openSettings);
  if (d?.status === "checking" && !d.models.length)
    return (
      <div className="model-empty">
        <Spinner /> Asking Pi for models…
      </div>
    );
  if (d?.status === "error" && !d.models.length)
    return (
      <div className="model-empty">
        <p>{d.error ?? "Couldn't reach Pi."}</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => openSettings("pi")}
        >
          Open Pi settings
        </button>
      </div>
    );
  return (
    <div className="model-empty">
      <KeyRound size={18} />
      <p>No models yet. Sign in to a provider so Pi can use its models.</p>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => openSettings("keys")}
      >
        Add a provider
      </button>
    </div>
  );
}

const RAIL_FAV = "★";

/** Price and size of a model, as a short line. */
function modelFacts(m: ModelInfo) {
  const k = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
      : `${Math.round(n / 1000)}k`;
  return [
    m.contextLimit ? `${k(m.contextLimit)} context` : "",
    m.outputCost ? `$${m.outputCost}/M out` : m.outputCost === 0 ? "free" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Star or unstar a Pi model. */
export function toggleFavorite(id: string) {
  const { settings, updateSettings } = useStore.getState();
  const favorites = settings.favorites.includes(id)
    ? settings.favorites.filter((f) => f !== id)
    : [...settings.favorites, id];
  updateSettings({ favorites });
}

/** Thinking levels of the selected model, as a row of choices (in the model picker's footer). */
function ThinkingRow({ model }: { model?: ModelInfo }) {
  const effort = useStore((s) => effortFor(s.settings, s.chats.find((c) => c.id === s.activeChatId), model ? { plan: "pi", id: model.id } : undefined));
  const setEffort = useStore((s) => s.setEffort);
  const levels = model?.reasoning.efforts ?? [];
  const shown = nearestEffort(levels, effort) ?? effort;
  return (
    <div className="mp-foot">
      <span className="mp-foot-label">Thinking</span>
      {levels.length ? (
        <span
          className="mp-levels"
          role="radiogroup"
          aria-label="Thinking level"
        >
          {levels.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === shown}
              className="mp-level"
              onClick={() => model && setEffort(l, { plan: "pi", id: model.id })}
            >
              {SHORT[l]}
            </button>
          ))}
        </span>
      ) : (
        <span className="mp-foot-value">
          {model ? "model default" : "pick a model"}
        </span>
      )}
    </div>
  );
}

export function ModelPicker({ dropUp, deviceId }: { dropUp: boolean; deviceId?: string }) {
  const pluginVersion = usePlugins((s) => s.version);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const selection = useStore(selectionFor);
  const detection = useDeviceDetection(deviceId);
  const favorites = useStore((s) => s.settings.favorites);
  const setSelection = useStore((s) => s.setSelection);
  const openSettings = useStore((s) => s.openSettings);

  const current = isAuto(selection)
    ? undefined
    : findModel(detection, selection);
  const all = detection.pi?.models ?? [];
  // This device's Pi settings can scope the picker (`enabledModels`); "Show all" widens it again.
  const scope = detection.pi?.scope;
  const scoped = hasModelScope(scope);
  // Remembered per device: following the picker to another device shows that device's choice.
  const [showAll, setShowAll] = useDevicePref("models.showAll", deviceId);
  const shown = useMemo(
    () =>
      showAll
        ? all
        : scopedModels(
            all,
            scope,
            !isAuto(selection) && selection?.plan === "pi"
              ? selection.id
              : undefined,
          ),
    [all, scope, showAll, selection],
  );
  const providers = useMemo(
    () => providerGroups(shown).map((g) => g.provider),
    [shown, pluginVersion],
  );
  const favModels = useMemo(
    () =>
      favorites
        .map((id) => shown.find((m) => m.id === id))
        .filter((m): m is ModelInfo => !!m),
    [shown, favorites],
  );
  const [tab, setTab] = useState<string>(RAIL_FAV);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<{
    up: boolean;
    max: number;
    pos: React.CSSProperties;
  }>({ up: dropUp, max: 560, pos: {} });
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Open right at the pill, toward whichever side has room. The height is fixed (not sized to the
  // list) so switching providers or searching doesn't make the panel jump.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const pill = anchor.current?.getBoundingClientRect();
      const wrap = anchor.current
        ?.closest(".composer-wrap")
        ?.getBoundingClientRect();
      if (!pill || !wrap) return;
      const below = window.innerHeight - pill.bottom - 16;
      const above = pill.top - 16;
      const up = dropUp
        ? above >= 360 || above >= below
        : below < 360 && above > below;
      const width = Math.min(420, window.innerWidth - 24);
      const left =
        window.innerWidth <= 768
          ? 0
          : Math.max(
              Math.min(
                pill.left - wrap.left,
                window.innerWidth - 12 - width - wrap.left,
              ),
              12 - wrap.left,
            );
      const pos: React.CSSProperties = up
        ? { left, top: "auto", bottom: wrap.bottom - pill.top + 6 }
        : { left, bottom: "auto", top: pill.bottom - wrap.top + 6 };
      setLayout({
        up,
        max: Math.max(220, Math.min(480, up ? above : below)),
        pos,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, dropUp]);

  // Open on the favorites (if any), else on the selected model's provider.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setShowAll(false);
    if (window.matchMedia("(pointer: fine)").matches)
      requestAnimationFrame(() => search.current?.focus());
    setTab(
      favModels.length
        ? RAIL_FAV
        : current
          ? providerOf(current)
          : (providers[0] ?? RAIL_FAV),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const q = query.trim();
  const rows: ModelInfo[] = useMemo(() => {
    if (q) return searchProviderGroups(shown, q).flatMap((g) => g.models);
    if (tab === RAIL_FAV) return favModels;
    return shown.filter((m) => providerOf(m) === tab);
  }, [shown, q, tab, favModels]);
  const checking = detection.pi?.status === "checking";
  const label = current
    ? current.name
    : all.length
      ? "Select model"
      : checking
        ? "Loading models…"
        : "Set up Pi";

  const choose = (id: string) => {
    setSelection({ plan: "pi", id });
    setOpen(false);
  };

  return (
    <div className="picker picker-static">
      <button
        ref={anchor}
        type="button"
        className={cx("pill pill-plain pill-model", open && "pill-open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() =>
          all.length || checking ? setOpen((o) => !o) : openSettings("keys")
        }
      >
        {current ? (
          <ProviderIcon provider={providerOf(current)} />
        ) : !all.length && !checking ? (
          <KeyRound size={14} />
        ) : null}
        <span className="pill-text">{label}</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        className={cx("mp", layout.up ? "drop-up" : "drop-down")}
        style={{ ...layout.pos, height: layout.max }}
        label="Choose a model"
      >
        <div
          className="mp-rail"
          role="tablist"
          aria-label="Providers"
          onKeyDown={(e) => arrowNav(e)}
        >
          <button
            type="button"
            role="tab"
            aria-selected={!q && tab === RAIL_FAV}
            className="mp-rail-btn"
            data-tooltip="Favorites"
            data-tooltip-side="right"
            onClick={() => (setTab(RAIL_FAV), setQuery(""))}
          >
            <Star size={16} fill="currentColor" />
          </button>
          {/* Providers scroll on their own so Favorites stays in view. */}
          <div className="mp-rail-scroll">
            {providers.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={!q && tab === p}
                className="mp-rail-btn"
                data-tooltip={providerName(p)}
                data-tooltip-side="right"
                onClick={() => (setTab(p), setQuery(""))}
              >
                <ProviderIcon provider={p} />
              </button>
            ))}
          </div>
        </div>
        <div className="mp-main">
          <label className="mp-search">
            <Search size={15} />
            <input
              ref={search}
              value={query}
              placeholder="Search models…"
              aria-label="Search models"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  list.current?.querySelector<HTMLElement>(".mp-pick")?.focus();
                } else if (e.key === "Enter" && rows[0]) {
                  e.preventDefault();
                  choose(rows[0].id);
                }
              }}
            />
            {checking && <Spinner size={12} />}
          </label>
          {scoped && (
            <button
              type="button"
              role="switch"
              className="mp-scope"
              aria-checked={showAll}
              aria-label={`Show all ${all.length} models`}
              onClick={() => setShowAll(!showAll)}
            >
              <span>Show all {all.length} models</span>
              <span className="toggle toggle-sm" aria-hidden data-on={showAll}>
                <span className="toggle-knob" />
              </span>
            </button>
          )}
          <div ref={list} className="mp-list" onKeyDown={(e) => arrowNav(e)}>
            {rows.map((m) => {
              const selected =
                !isAuto(selection) &&
                selection?.plan === "pi" &&
                selection.id === m.id;
              const fav = favorites.indexOf(m.id);
              return (
                <div key={m.id} className="mp-row" aria-selected={selected}>
                  <button
                    type="button"
                    className="mp-pick"
                    title={m.id}
                    onClick={() => choose(m.id)}
                  >
                    <span className="mp-name">{m.name}</span>
                    <span className="mp-sub">
                      <ProviderIcon provider={providerOf(m)} />
                      <span className="mp-sub-text">
                        {providerName(providerOf(m))}
                        {modelFacts(m) && ` · ${modelFacts(m)}`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cx("mp-star", fav >= 0 && "mp-star-on")}
                    aria-label={
                      fav >= 0 ? `Unstar ${m.name}` : `Star ${m.name}`
                    }
                    aria-pressed={fav >= 0}
                    onClick={() => toggleFavorite(m.id)}
                  >
                    <Star size={15} fill={fav >= 0 ? "currentColor" : "none"} />
                  </button>
                </div>
              );
            })}
            {!rows.length &&
              (q ? (
                <div className="model-empty">
                  <p>No models match “{q}”.</p>
                </div>
              ) : tab === RAIL_FAV && shown.length ? (
                <div className="model-empty">
                  <Star size={18} />
                  <p>Star the models you use most.</p>
                </div>
              ) : !scoped ? (
                <PiStatus detection={detection} />
              ) : (
                <div className="model-empty">
                  <p>
                    {showAll
                      ? "No models here."
                      : "No models from this device's Pi scope here."}
                  </p>
                </div>
              ))}
          </div>
          <ThinkingRow model={current} />
        </div>
      </Popover>
    </div>
  );
}
