import { Check, KeyRound, Search, ShieldAlert, ShieldCheck, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  EFFORTS,
  nearestEffort,
  type Effort,
  type ModelInfo,
  type PlanId,
  type ThreadRuntime,
} from "../../shared/types";
import { findModel, isAuto, providerName, providerOf } from "../lib/models";
import { usePlugins } from "../lib/plugins";
import { hasModelScope, providerGroups, scopedModels, searchProviderGroups } from "../lib/modelSearch";
import { MODELS_STALE, composerEffort, composerSpeed, hasPermissionModes, permissionKey, permissionOf, runtimeOf, selectionFor, useStore } from "../lib/store";
import type { Detection } from "../lib/types";
import { effortFor, supportedSpeed } from "../lib/effort";
import { arrowNav, cx, useDevicePref } from "../lib/ui";
import { CodexMark, FxMark, Popover, ProviderIcon, Spinner } from "./primitives";

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
const PENDING_FX: Detection = { plan: "fx", status: "checking", models: [] };
const PENDING_CODEX: Detection = { plan: "codex", status: "checking", models: [] };
const PENDING_CURSOR: Detection = { plan: "cursor", status: "checking", models: [] };
/** The agent whose models a detection lists. */
const planOf = (detection: Partial<Record<PlanId, Detection>>): "pi" | "fx" | "codex" | "cursor" => (detection.cursor ? "cursor" : detection.codex ? "codex" : detection.fx ? "fx" : "pi");

/**
 * The models the composer can use: this server's, or those of the paired device the thread works
 * on (fetched once its first turn needs them, and re-asked when they're old).
 */
function useDeviceDetection(deviceId?: string): Partial<Record<PlanId, Detection>> {
  const local = useStore((s) => s.detection);
  const remote = useStore((s) => (deviceId ? s.remoteModels[deviceId] : undefined));
  const load = useStore((s) => s.loadDeviceModels);
  // Native runtimes list their own models, not Pi provider models.
  const runtime = useStore((s) => runtimeOf(s, s.activeChatId));
  const native = runtime === "fx" || runtime === "codex" || runtime === "cursor";
  const list = useStore((s) => runtime === "cursor" ? s.cursorModels[deviceId ?? ""] : runtime === "codex" ? s.codexModels[deviceId ?? ""] : runtime === "fx" ? s.fxModels[deviceId ?? ""] : undefined);
  const loadNative = useStore((s) => runtime === "cursor" ? s.loadCursorModels : runtime === "codex" ? s.loadCodexModels : s.loadFxModels);
  const detection = useMemo(
    () => (native ? { [runtime]: list ?? (runtime === "cursor" ? PENDING_CURSOR : runtime === "codex" ? PENDING_CODEX : PENDING_FX) } : deviceId ? { pi: remote ?? PENDING } : local),
    [native, runtime, list, deviceId, remote, local],
  );
  useEffect(() => {
    if (!native) return;
    const stale = list && list.status !== "checking" && Date.now() - (list.checkedAt ?? 0) > MODELS_STALE;
    if (!list || stale) void loadNative(deviceId, !!list);
  }, [native, list, deviceId, loadNative]);
  useEffect(() => {
    if (!deviceId || native) return;
    const stale =
      remote &&
      remote.status !== "checking" &&
      Date.now() - (remote.checkedAt ?? 0) > MODELS_STALE;
    if (!remote || stale) void load(deviceId, !!remote);
  }, [deviceId, remote, load, native]);
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
        ? model?.id.startsWith("fx/")
          ? "This fx version can't set reasoning effort. Update fx (`fx upgrade`) to choose it here."
          : `${model?.name} uses its default reasoning`
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

/**
 * The speed (service tier) for the selected model, right of the effort picker. Only shown when the
 * provider lists faster tiers for the model (ModelInfo.speeds), and offers only those plus standard.
 */
export function SpeedPicker({ dropUp, deviceId }: { dropUp: boolean; deviceId?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const selection = useStore(selectionFor);
  const detection = useDeviceDetection(deviceId);
  const wanted = useStore(composerSpeed);
  const setSpeed = useStore((s) => s.setSpeed);
  const model = isAuto(selection) ? undefined : findModel(detection, selection);
  const speeds = model?.speeds ?? [];
  if (!speeds.length) return null;
  const shown = supportedSpeed(speeds, wanted);
  const current = speeds.find((s) => s.id === shown);
  const options: { id?: string; name: string; description?: string }[] = [{ name: "Standard", description: "Default speed and usage" }, ...speeds];

  return (
    <div className="picker">
      <button
        ref={anchor}
        type="button"
        className={cx("pill pill-plain", open && "pill-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={open ? undefined : current?.description ? `Speed: ${current.description}` : "Speed"}
        data-tooltip-side={dropUp ? "top" : "bottom"}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.name ?? "Standard"}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        className="menu effort-menu speed-menu"
        role="listbox"
        label="Speed"
        fixed={dropUp ? "up" : "auto"}
      >
        <div className="menu-label">Speed</div>
        <div onKeyDown={(e) => arrowNav(e)}>
          {options.map((o) => (
            <button
              key={o.id ?? ""}
              type="button"
              role="option"
              aria-selected={shown === o.id}
              className="menu-item"
              onClick={() => {
                setSpeed(o.id);
                setOpen(false);
              }}
            >
              <span className="menu-item-label">
                {o.name}
                {o.description && <span className="speed-desc">{o.description}</span>}
              </span>
              {shown === o.id && <Check size={15} className="menu-check" />}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

const PERMISSION_STALE = 10 * 60 * 1000;
const RUNTIME_NAME: Partial<Record<ThreadRuntime, string>> = { codex: "Codex", cursor: "Cursor" };

/**
 * The permission mode for a Codex or Cursor thread, as that runtime lists its modes on the device
 * (Codex: its permission profiles for the folder; Cursor: the modes its installed CLI offers).
 * "Default" sends nothing, so the runtime's own configuration applies.
 */
export function PermissionPicker({ dropUp, chatId, deviceId, cwd }: { dropUp: boolean; chatId?: string; deviceId?: string; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const runtime = useStore((s) => runtimeOf(s, chatId));
  const native = hasPermissionModes(runtime);
  const key = native ? permissionKey(runtime, deviceId, cwd) : "";
  const listing = useStore((s) => (native ? s.permissionModes[key] : undefined));
  const load = useStore((s) => s.loadPermissionModes);
  const picked = useStore((s) => permissionOf(s, chatId));
  const setPermission = useStore((s) => s.setPermission);
  useEffect(() => {
    if (!native) return;
    const stale = listing && listing.status !== "checking" && Date.now() - listing.checkedAt > PERMISSION_STALE;
    if (!listing || stale) void load(runtime, deviceId, cwd, !!listing);
  }, [native, runtime, listing, deviceId, cwd, load]);
  if (!native) return null;
  const modes = listing?.modes ?? [];
  const name = RUNTIME_NAME[runtime];
  // The runtime's own default, when it names one it lists; picking it explicitly is the same as Default.
  const configured = modes.find((m) => m.id === listing?.defaultMode);
  const current = picked ? modes.find((m) => m.id === picked) : undefined;
  const label = current?.name ?? (picked ? picked : configured ? configured.name : "Default");
  const risky = /full-access|force|danger/.test(current?.id ?? "");
  const tooltip = listing?.status === "error" && !modes.length
    ? `Couldn't list ${name}'s permission modes: ${listing.error}`
    : current?.description
      ? `Permissions: ${current.description}`
      : picked
        ? `Permissions: ${picked}`
        : `Permissions: ${name}'s configured default${configured ? ` (${configured.name})` : ""}`;
  return (
    <div className="picker">
      <button
        ref={anchor}
        type="button"
        className={cx("pill pill-plain permission-pill", open && "pill-open", risky && "permission-risky")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Permissions: ${label}`}
        data-tooltip={open ? undefined : tooltip}
        data-tooltip-side={dropUp ? "top" : "bottom"}
        onClick={() => setOpen((o) => !o)}
      >
        {risky ? <ShieldAlert size={14} aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
        {label}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu effort-menu speed-menu" role="listbox" label="Permissions" fixed={dropUp ? "up" : "auto"}>
        <div className="menu-label">{name} permissions</div>
        <div onKeyDown={(e) => arrowNav(e)}>
          {/* Cursor lists its no-flag mode itself; Codex's default is whatever its config resolves to. */}
          {!modes.some((m) => m.id === listing?.defaultMode) && (
            <button type="button" role="option" aria-selected={!picked} className="menu-item" onClick={() => { setPermission(undefined, chatId); setOpen(false); }}>
              <span className="menu-item-label">
                Default
                <span className="speed-desc">{name}'s own configuration</span>
              </span>
              {!picked && <Check size={15} className="menu-check" />}
            </button>
          )}
          {listing?.status === "checking" && !modes.length && <div className="menu-item" aria-disabled><Spinner /> Asking {name}…</div>}
          {listing?.status === "error" && !modes.length && <div className="menu-item" aria-disabled>{listing.error}</div>}
          {modes.map((m) => {
            const isDefault = m.id === listing?.defaultMode;
            const selected = picked ? picked === m.id : isDefault;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected}
                className="menu-item"
                disabled={m.allowed === false}
                title={m.allowed === false ? `Not allowed by ${name}'s managed requirements` : undefined}
                onClick={() => { setPermission(isDefault ? undefined : m.id, chatId); setOpen(false); }}
              >
                <span className="menu-item-label">
                  {m.name}{isDefault && " (default)"}
                  {m.description && <span className="speed-desc">{m.description}</span>}
                </span>
                {selected && <Check size={15} className="menu-check" />}
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
  const openSettings = useStore((s) => s.openSettings);
  if (detection.fx || detection.codex || detection.cursor) {
    const f = (detection.cursor ?? detection.codex ?? detection.fx)!;
    const name = detection.cursor ? "Cursor" : detection.codex ? "Codex" : "fx";
    if (f.status === "checking" && !f.models.length)
      return (
        <div className="model-empty">
          <Spinner /> Asking {name} for models…
        </div>
      );
    return (
      <div className="model-empty">
        {detection.cursor ? <ProviderIcon provider="cursor" /> : detection.codex ? <CodexMark size={18} /> : <FxMark size={18} />}
        <p>{f.error ?? `${name} has no models yet. Sign in with \`${detection.cursor ? "agent" : detection.codex ? "codex" : "fx"} login\` on this device.`}</p>
      </div>
    );
  }
  const d = detection.pi;
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
function ThinkingRow({ model, plan }: { model?: ModelInfo; plan: "pi" | "fx" | "codex" | "cursor" }) {
  const effort = useStore((s) => effortFor(s.settings, s.chats.find((c) => c.id === s.activeChatId), model ? { plan, id: model.id } : undefined));
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
              onClick={() => model && setEffort(l, { plan, id: model.id })}
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
  const plan = planOf(detection);
  const all = detection[plan]?.models ?? [];
  // This device's Pi settings can scope the picker (`enabledModels`); "Show all" widens it again.
  const scope = detection[plan]?.scope;
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
            !isAuto(selection) && selection?.plan === plan
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
  const checking = detection[plan]?.status === "checking";
  const label = current
    ? current.name
    : all.length
      ? "Select model"
      : checking
        ? // First fetch on a never-seen device: name the pick rather than say it's loading.
          !isAuto(selection) && selection?.plan === plan
          ? selection.id.split("/").pop()!
          : "Select model"
        : plan === "fx" || plan === "codex" || plan === "cursor"
          ? `Set up ${plan === "cursor" ? "Cursor" : plan === "codex" ? "Codex" : "fx"}`
          : "Set up Pi";

  const choose = (id: string) => {
    setSelection({ plan, id });
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
          all.length || checking || plan === "fx" || plan === "codex" || plan === "cursor" ? setOpen((o) => !o) : openSettings("keys")
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
                selection?.plan === plan &&
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
          <ThinkingRow model={current} plan={plan} />
        </div>
      </Popover>
    </div>
  );
}
