import { Check, KeyRound, Search, ShieldAlert, ShieldCheck, Star, Zap } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { codexDetection, claudeDetection, composerEffort, modelsDueIn, composerSpeed, hasPermissionModes, permissionKey, permissionOf, runtimeOf, selectionFor, useStore } from "../lib/store";
import type { Detection } from "../lib/types";
import { supportedSpeed } from "../lib/effort";
import { arrowNav, cx, useDevicePref } from "../lib/ui";
import { RUNTIME_LABEL, RuntimeIcon, useRuntimeOptions } from "./Workspace";
import { runtimeName } from "../lib/runtimes";
import { REMOTE_CONTROL } from "../../shared/remoteControl";
import { GrokMark, HermesMark, OpencodeMark, ClaudeMark, CodexMark, CursorMark, FxMark, Popover, ProviderIcon, Spinner, Toggle } from "./primitives";

const SHORT: Record<Effort, string> = {
  off: "Off",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};
const LONG: Record<Effort, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A paired device's list before it arrives: the picker says it's asking, not "no models". */
const PENDING: Detection = { plan: "pi", status: "checking", models: [] };
const PENDING_FX: Detection = { plan: "fx", status: "checking", models: [] };
const PENDING_CODEX: Detection = { plan: "codex", status: "checking", models: [] };
const PENDING_CURSOR: Detection = { plan: "cursor", status: "checking", models: [] };
const PENDING_CLAUDE: Detection = { plan: "claude", status: "checking", models: [] };
const PENDING_OPENCODE: Detection = { plan: "opencode", status: "checking", models: [] };
const PENDING_HERMES: Detection = { plan: "hermes", status: "checking", models: [] };
const PENDING_GROK: Detection = { plan: "grok", status: "checking", models: [] };
/** The agent whose models a detection lists. */
const planOf = (detection: Partial<Record<PlanId, Detection>>): "pi" | "fx" | "codex" | "cursor" | "claude" | "opencode" | "grok" | "hermes" => (detection.hermes ? "hermes" : detection.grok ? "grok" : detection.opencode ? "opencode" : detection.claude ? "claude" : detection.cursor ? "cursor" : detection.codex ? "codex" : detection.fx ? "fx" : "pi");

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
  const native = runtime === "fx" || runtime === "codex" || runtime === "cursor" || runtime === "claude" || runtime === "opencode" || runtime === "grok" || runtime === "hermes";
  const list = useStore((s) => runtime === "hermes" ? s.hermesModels[deviceId ?? ""] : runtime === "grok" ? s.grokModels[deviceId ?? ""] : runtime === "opencode" ? s.opencodeModels[deviceId ?? ""] : runtime === "claude" ? s.claudeModels[deviceId ?? ""] : runtime === "cursor" ? s.cursorModels[deviceId ?? ""] : runtime === "codex" ? s.codexModels[deviceId ?? ""] : runtime === "fx" ? s.fxModels[deviceId ?? ""] : undefined);
  const loadNative = useStore((s) => runtime === "hermes" ? s.loadHermesModels : runtime === "grok" ? s.loadGrokModels : runtime === "opencode" ? s.loadOpencodeModels : runtime === "claude" ? s.loadClaudeModels : runtime === "cursor" ? s.loadCursorModels : runtime === "codex" ? s.loadCodexModels : s.loadFxModels);
  const chat = useStore((s) => s.chats.find((c) => c.id === s.activeChatId));
  const detection = useMemo(
    () => (native ? { [runtime]: (runtime === "claude" && list ? claudeDetection(list, chat) : runtime === "codex" && list ? codexDetection(list, chat) : list) ?? (runtime === "hermes" ? PENDING_HERMES : runtime === "grok" ? PENDING_GROK : runtime === "opencode" ? PENDING_OPENCODE : runtime === "claude" ? PENDING_CLAUDE : runtime === "cursor" ? PENDING_CURSOR : runtime === "codex" ? PENDING_CODEX : PENDING_FX) } : deviceId ? { pi: remote ?? PENDING } : local),
    [native, runtime, list, chat, deviceId, remote, local],
  );
  // Fetch when the list is missing or stale; a failed one is retried shortly while it's on screen.
  useEffect(() => {
    if (!native) return;
    const wait = modelsDueIn(list);
    if (wait === Infinity) return;
    const t = setTimeout(() => void loadNative(deviceId, !!list), wait);
    return () => clearTimeout(t);
  }, [native, list, deviceId, loadNative]);
  useEffect(() => {
    if (!deviceId || native) return;
    const wait = modelsDueIn(remote);
    if (wait === Infinity) return;
    const t = setTimeout(() => void load(deviceId, !!remote), wait);
    return () => clearTimeout(t);
  }, [deviceId, remote, load, native]);
  return detection;
}

/** The selected model's reasoning levels and the one in use, for the picker's Reasoning section and the pill. */
function useEffortChoice(deviceId?: string) {
  const effort = useStore(composerEffort);
  const selection = useStore(selectionFor);
  const detection = useDeviceDetection(deviceId);
  const auto = isAuto(selection);
  const model = auto ? undefined : findModel(detection, selection);
  // Availability comes from the model's metadata; the auto router applies the level wherever supported.
  const levels: Effort[] = auto ? [...EFFORTS] : (model?.reasoning.efforts ?? []);
  const shown = nearestEffort(levels, effort) ?? effort;
  // Toggle-only models (thinking on/off, no levels): "medium" means "on, at the model's default".
  const onOff = !!model && model.reasoning.mode === "none" && model.reasoning.toggle;
  const labelOf = (e: Effort, short = false) => (onOff && e === "medium" ? "On" : short ? SHORT[e] : LONG[e]);
  const note =
    !model && !auto
      ? "Select a model first"
      : !levels.length
        ? model?.id.startsWith("fx/")
          ? "This fx version can't set reasoning effort. Update fx (`fx upgrade`) to choose it here."
          : `${model?.name} uses its default reasoning`
        : undefined;
  return { model, levels, shown, labelOf, note };
}

/** The selected model's faster service tiers (ModelInfo.speeds) and the one in use; none listed means no choice. */
function useSpeedChoice(deviceId?: string) {
  const selection = useStore(selectionFor);
  const detection = useDeviceDetection(deviceId);
  const wanted = useStore(composerSpeed);
  const model = isAuto(selection) ? undefined : findModel(detection, selection);
  const speeds = model?.speeds ?? [];
  const shown = supportedSpeed(speeds, wanted);
  return { speeds, current: speeds.find((s) => s.id === shown) };
}

/**
 * The model picker's Reasoning section: a column beside the list on a wide picker, a row of levels
 * under it on a narrow one (CSS decides). Picking a level keeps the picker open.
 */
export function ReasoningSection({ deviceId }: { deviceId?: string }) {
  const { model, levels, shown, labelOf, note } = useEffortChoice(deviceId);
  const setEffort = useStore((s) => s.setEffort);
  return (
    <section className="mp-effort" aria-label="Reasoning effort">
      <div className="mp-effort-head" title={model ? `For ${model.name}` : undefined}>
        <span className="mp-section-label">Reasoning</span>
      </div>
      {note ? (
        <p className="mp-effort-note">{note}</p>
      ) : (
        <div className="mp-effort-levels" role="radiogroup" aria-label="Reasoning effort" onKeyDown={(e) => arrowNav(e, undefined, { horizontal: true })}>
          {levels.map((level) => (
            <button key={level} type="button" role="radio" aria-checked={shown === level} tabIndex={shown === level ? 0 : -1} className="mp-effort-level" onClick={() => setEffort(level)}>
              <span className="mp-effort-long">{labelOf(level)}</span>
              <span className="mp-effort-short" aria-hidden>{labelOf(level, true)}</span>
              {shown === level && <Check size={14} className="mp-effort-check" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Standard or one of the model's faster tiers, at the foot of the model picker. Hidden when the model lists none. */
export function SpeedToggle({ deviceId }: { deviceId?: string }) {
  const { speeds, current } = useSpeedChoice(deviceId);
  const setSpeed = useStore((s) => s.setSpeed);
  if (!speeds.length) return null;
  const options: { id?: string; name: string; description?: string }[] = [{ name: "Standard", description: "Default speed and usage" }, ...speeds];
  return (
    <span className="mp-speed" role="radiogroup" aria-label="Speed" onKeyDown={(e) => arrowNav(e, undefined, { horizontal: true })}>
      {options.map((o) => (
        <button
          key={o.id ?? ""}
          type="button"
          role="radio"
          aria-checked={current?.id === o.id}
          tabIndex={current?.id === o.id ? 0 : -1}
          className="mp-speed-opt"
          data-tooltip={o.description}
          data-tooltip-side="top"
          onClick={() => setSpeed(o.id)}
        >
          {o.id && <Zap size={13} aria-hidden />}
          {o.name}
        </button>
      ))}
    </span>
  );
}

const PERMISSION_STALE = 10 * 60 * 1000;
const RUNTIME_NAME: Partial<Record<ThreadRuntime, string>> = { codex: "Codex", cursor: "Cursor", claude: "Claude Code", opencode: "OpenCode", grok: "Grok", hermes: "Hermes" };

/**
 * The permission mode for a Codex or Cursor thread, as that runtime lists its modes on the device
 * (Codex: its permission profiles for the folder; Cursor: the modes its installed CLI offers).
 * "Default" sends nothing, so the runtime's own configuration applies. It sits outside the composer,
 * in the workspace row: above a new thread's composer, under a thread's.
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
  const risky = /full-access|force|danger|bypassPermissions/.test(current?.id ?? "");
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
        className={cx("ws-pill permission-pill", open && "ws-pill-open", risky && "permission-risky")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Permissions: ${label}`}
        data-tooltip={open ? undefined : tooltip}
        data-tooltip-side={dropUp ? "top" : "bottom"}
        onClick={() => setOpen((o) => !o)}
      >
        {risky ? <ShieldAlert size={13} aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
        <span className="ws-pill-text">{label}</span>
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
  if (detection.fx || detection.codex || detection.cursor || detection.claude || detection.opencode || detection.grok || detection.hermes) {
    const f = (detection.hermes ?? detection.grok ?? detection.opencode ?? detection.claude ?? detection.cursor ?? detection.codex ?? detection.fx)!;
    const name = detection.hermes ? "Hermes" : detection.grok ? "Grok" : detection.opencode ? "OpenCode" : detection.claude ? "Claude Code" : detection.cursor ? "Cursor" : detection.codex ? "Codex" : "fx";
    if (f.status === "checking" && !f.models.length)
      return (
        <div className="model-empty">
          <Spinner /> Asking {name} for models…
        </div>
      );
    return (
      <div className="model-empty">
        {detection.hermes ? <HermesMark size={18} /> : detection.grok ? <GrokMark size={18} /> : detection.opencode ? <OpencodeMark size={18} /> : detection.claude ? <ClaudeMark size={18} /> : detection.cursor ? <CursorMark size={18} /> : detection.codex ? <CodexMark size={18} /> : <FxMark size={18} />}
        <p>{f.error ?? (detection.hermes ? "Run `hermes setup` on this device to configure models." : detection.grok ? "Grok has no models yet. Install it and run `grok login` on this device." : detection.opencode ? "OpenCode has no models yet. Install it and configure providers with `opencode` on this device." : detection.claude ? "Claude Code has no models yet. Install it and run `claude` once on this device to sign in." : `${name} has no models yet. Sign in with \`${detection.cursor ? "agent" : detection.codex ? "codex" : "fx"} login\` on this device.`)}</p>
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
/** The picker's width on a wide screen: rail, list and the Reasoning column side by side. */
const PICKER_WIDTH = 540;

/** Price and size of a model, as a short line. */
function modelFacts(m: ModelInfo) {
  const k = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
      : `${Math.round(n / 1000)}k`;
  return [
    m.contextLimit ? `${k(m.contextLimit)} ctx` : "",
    m.outputCost ? `$${m.outputCost}/M` : m.outputCost === 0 ? "free" : "",
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

/**
 * The model picker's footer: the model's speed on the left, and the new thread's runtime, whose
 * models the list above shows. Once a thread has started its runtime is fixed, so the row just names it.
 */
function PickerFoot({ deviceId }: { deviceId?: string }) {
  const started = useStore((s) => s.chats.some((c) => c.id === s.activeChatId));
  const fixed = useStore((s) => runtimeOf(s, s.activeChatId));
  const updateSettings = useStore((s) => s.updateSettings);
  const openSettings = useStore((s) => s.openSettings);
  const { options, missing, runtime } = useRuntimeOptions();
  return (
    <div className="mp-foot">
      <SpeedToggle deviceId={deviceId} />
      <span className="mp-foot-label">Runtime</span>
      {started ? (
        <span className="mp-foot-value mp-runtime-fixed" data-tooltip="Fixed once a thread starts" data-tooltip-side="top">
          <RuntimeIcon runtime={fixed} size={13} />
          {RUNTIME_LABEL[fixed]}
        </span>
      ) : (
        <span className="mp-levels" role="radiogroup" aria-label="Runtime" onKeyDown={(e) => arrowNav(e)}>
          {options.map((o) => {
            const absent = missing(o.runtime);
            return (
              <button
                key={o.runtime}
                type="button"
                role="radio"
                aria-checked={o.runtime === runtime}
                aria-label={RUNTIME_LABEL[o.runtime]}
                className={cx("mp-level mp-runtime", absent && "mp-runtime-missing")}
                data-tooltip={absent ? `${runtimeName(o.runtime)} isn't installed · Set up…` : RUNTIME_LABEL[o.runtime]}
                data-tooltip-side="top"
                onClick={() => (absent ? openSettings("runtimes") : updateSettings({ threadRuntime: o.runtime }))}
              >
                <RuntimeIcon runtime={o.runtime} size={14} />
              </button>
            );
          })}
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
  const effort = useEffortChoice(deviceId);
  const speed = useSpeedChoice(deviceId);

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
  }>({ up: dropUp, max: 380, pos: {} });
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
      const width = Math.min(PICKER_WIDTH, window.innerWidth - 24);
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
        max: Math.max(220, Math.min(380, up ? above : below)),
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
  // Switching runtime in the footer swaps the whole list: start over on its favorites or first provider.
  const lastPlan = useRef(plan);
  useEffect(() => {
    // Wait for a list that's still arriving, so the tab isn't picked from nothing.
    if (lastPlan.current === plan || (!providers.length && detection[plan]?.status === "checking")) return;
    lastPlan.current = plan;
    setTab(favModels.length ? RAIL_FAV : (providers[0] ?? RAIL_FAV));
  }, [plan, favModels.length, providers, detection]);

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
        : plan === "fx" || plan === "codex" || plan === "cursor" || plan === "claude" || plan === "opencode" || (plan === "grok" || plan === "hermes")
          ? `Set up ${plan === "hermes" ? "Hermes" : plan === "grok" ? "Grok" : plan === "opencode" ? "OpenCode" : plan === "claude" ? "Claude Code" : plan === "cursor" ? "Cursor" : plan === "codex" ? "Codex" : "fx"}`
          : "Set up Pi";

  // The pill says it all: model, then reasoning level, then a bolt while a faster tier is on.
  const effortLabel = current && !effort.note ? (effort.shown === "medium" ? effort.labelOf(effort.shown) : effort.labelOf(effort.shown, true)) : undefined;
  const pillLabel = [label, effortLabel && `${effortLabel} reasoning`, speed.current?.name].filter(Boolean).join(", ");

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
        aria-label={`Model: ${pillLabel}`}
        onClick={() =>
          all.length || checking || plan === "fx" || plan === "codex" || plan === "cursor" || plan === "claude" || plan === "opencode" || (plan === "grok" || plan === "hermes") ? setOpen((o) => !o) : openSettings("keys")
        }
      >
        {current ? (
          <ProviderIcon provider={providerOf(current)} />
        ) : !all.length && !checking ? (
          <KeyRound size={14} />
        ) : null}
        <span className="pill-text">{label}</span>
        {effortLabel && <span className="pill-effort">{effortLabel}</span>}
        {speed.current && <Zap size={14} className="pill-fast" aria-hidden />}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        className={cx("mp", layout.up ? "drop-up" : "drop-down")}
        style={{ ...layout.pos, height: layout.max }}
        label="Choose a model"
      >
        <div className="mp-body">
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
              <Star size={15} fill="currentColor" />
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
              <Search size={14} />
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
            {/* ↑/↓ go from model to model; a row's star is a Tab away. */}
            <div ref={list} className="mp-list" onKeyDown={(e) => arrowNav(e, ".mp-pick")}>
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
                      title={`${providerName(providerOf(m))} · ${m.id}`}
                      onClick={() => choose(m.id)}
                    >
                      <ProviderIcon provider={providerOf(m)} />
                      <span className="mp-name">{m.name}</span>
                      {modelFacts(m) && <span className="mp-facts">{modelFacts(m)}</span>}
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
                      <Star size={13} fill={fav >= 0 ? "currentColor" : "none"} />
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
          </div>
          <ReasoningSection deviceId={deviceId} />
          <PickerFoot deviceId={deviceId} />
        </div>
      </Popover>
    </div>
  );
}

/**
 * Remote Control, as each vendor offers it, on a row of its own under the composer. Claude Code opts
 * in per session, so a new thread can start with it on. Codex pairs a daemon for the whole machine
 * and Cursor sets it in the account: for those the switch is off and disabled, with one line saying where it's set.
 */
export function RemoteControlToggle({ chatId }: { chatId?: string }) {
  const id = useId();
  const runtime = useStore((s) => runtimeOf(s, chatId));
  const chatOn = useStore((s) => (chatId ? !!s.chats.find((c) => c.id === chatId)?.remoteControl : false));
  const draftOn = useStore((s) => s.draftRemoteControl);
  const setDraft = useStore((s) => s.setDraftRemoteControl);
  const remote = REMOTE_CONTROL[runtime];
  if (!remote) return null;
  // A thread keeps what it started with: only Claude Code threads that opted in show it afterwards.
  if (chatId && (!chatOn || remote.scope !== "thread")) return null;
  const perThread = remote.scope === "thread";
  const note = !perThread
    ? remote.scope === "machine" ? "Set per machine, not per thread" : `Set in your ${RUNTIME_NAME[runtime]} account`
    : chatId ? "On since this thread started" : "Needs a claude.ai sign-in";
  return (
    <div className="remote-control-row" data-runtime={runtime}>
      <label htmlFor={id} className="remote-control-label">Remote control</label>
      <Toggle id={id} className="toggle-sm" checked={perThread && (chatId ? chatOn : draftOn)} disabled={!perThread || !!chatId} onChange={setDraft} label="Remote control" describedBy={`${id}-note`} />
      <span id={`${id}-note`} className="remote-control-note">{note}</span>
    </div>
  );
}
