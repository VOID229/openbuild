import { ArrowUp, Bell, Cable, ChevronRight, MonitorSmartphone, CircleUser, FolderGit2, Key, Keyboard, Palette, Pencil, Plus, Puzzle, Settings2, Shield, SquareTerminal, Trash2, UserRound, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import { lowestEffort, nearestEffort, TEXT_RUNTIMES, type RuntimeStatus, type TextRuntime, type ThreadRuntime } from "../../shared/types";
import { cloudConfigured } from "../lib/cloud";
import { fastTarget } from "../lib/models";
import { leaveSettings, openSettingsSection, settingsUp } from "../lib/pages";
import { UPDATABLE_RUNTIMES, runtimeEnabled, runtimeName } from "../lib/runtimes";
import { cachedRuntimeStatuses, loadRuntimeStatuses } from "../lib/runtimeStatus";
import { isShortcutRecording } from "../lib/shortcuts";
import { loadPlanModels, planDetection, useStore, type SettingsSection } from "../lib/store";
import type { FontStyle, NamingModel, Theme } from "../lib/types";
import { arrowNav, cx, useMediaQuery } from "../lib/ui";
import { AccountSection } from "./Account";
import { DevicesSection } from "./DeviceSettings";
import { DictationSettings } from "./DictationSettings";
import { PiSection, ProjectsSection, ProvidersSection } from "./PiSettings";
import { useLightbox } from "./Lightbox";
import { EffortSelect, ModelSelect, OptionSelect } from "./ModelSelect";
import { Avatar, IconButton, SettingsBackContext, SettingsHeading, Toggle, type SettingsBackTarget } from "./primitives";
import { ShortcutsSection } from "./ShortcutSettings";
import { PluginSettingsPage, PluginSlot, usePluginSettingsSections } from "../lib/plugins";
import { PluginsSection } from "./PluginSettings";
import { RuntimesSection } from "./RuntimeSettings";
import { NavRow, PageHeader, SettingRow, SettingsGroup, SubPage } from "./SettingsUI";
import { RuntimeIcon } from "./Workspace";
import { BotsGlyph } from "./bots/BotAvatar";
import { BotsSettingsSection } from "./bots/BotSettings";
import { leaveSettingsAt, takeSettingsScroll } from "../lib/settingsPlace";

/** A section's icon: Lucide's, or one drawn to match them (OpenBots' bot). */
type NavIcon = LucideIcon | ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
type NavSection = { id: SettingsSection; label: string; icon: NavIcon };

/** The sections, in groups: you and the app; models and agents; where work happens; access. */
const GROUPS: NavSection[][] = [
  [
    { id: "profile", label: "Profile", icon: UserRound },
    { id: "general", label: "General", icon: Settings2 },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  ],
  [
    { id: "keys", label: "Providers", icon: Key },
    { id: "runtimes", label: "Harnesses", icon: Cable },
    { id: "pi", label: "Pi agent", icon: SquareTerminal },
    { id: "bots", label: "Bots", icon: BotsGlyph },
  ],
  [
    { id: "projects", label: "Projects", icon: FolderGit2 },
    { id: "devices", label: "Devices", icon: MonitorSmartphone },
    { id: "plugins", label: "Plugins", icon: Puzzle },
  ],
  [
    { id: "security", label: "Security", icon: Shield },
    { id: "account", label: "Account", icon: CircleUser },
  ],
];

const Heading = SettingsHeading;
const MIN_LOCAL_PASSWORD = 4;

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="md-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ Profile

async function avatarFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.88);
}

function ProfileSection() {
  const profile = useStore((s) => s.settings.profile);
  const updateProfile = useStore((s) => s.updateProfile);
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <Heading>Profile</Heading>
      <div className="avatar-edit">
        <Avatar src={profile.avatar} name={profile.name} size={72} />
        <button type="button" className="avatar-pencil" aria-label="Change photo" data-tooltip="Change photo" onClick={() => file.current?.click()}>
          <Pencil size={13} />
        </button>
        {profile.avatar && (
          <button type="button" className="link-btn" onClick={() => updateProfile({ avatar: undefined })}>
            Remove photo
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) updateProfile({ avatar: await avatarFromFile(f).catch(() => profile.avatar) });
          }}
        />
      </div>
      <Field label="Name" htmlFor="profile-name">
        <input id="profile-name" className="input" value={profile.name} autoComplete="name" onChange={(e) => updateProfile({ name: e.target.value })} />
      </Field>
      <Field label="Instructions" htmlFor="profile-bio">
        <textarea id="profile-bio" className="input textarea" rows={4} value={profile.bio} onChange={(e) => updateProfile({ bio: e.target.value })} />
        <p className="field-help">Shared with the model as context.</p>
      </Field>
      <div className="field-pair">
        <Field label="Location" htmlFor="profile-location">
          <input id="profile-location" className="input" value={profile.location} onChange={(e) => updateProfile({ location: e.target.value })} />
        </Field>
        <Field label="Language" htmlFor="profile-language">
          <input id="profile-language" className="input" value={profile.language} onChange={(e) => updateProfile({ language: e.target.value })} />
        </Field>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Notifications

function NotificationsSection() {
  const n = useStore((st) => st.settings.notifications);
  const update = useStore((st) => st.updateSettings);
  const chosen = UPDATABLE_RUNTIMES.filter((runtime) => !n.updateRuntimes || n.updateRuntimes.includes(runtime));
  const toggleRuntime = (runtime: ThreadRuntime, on: boolean) =>
    update({
      notifications: {
        ...n,
        updateRuntimes: UPDATABLE_RUNTIMES.filter((r) => (r === runtime ? on : chosen.includes(r))),
      },
    });
  return (
    <>
      <Heading>Notifications</Heading>
      <SettingRow label="New builds" desc="When an OpenBuild update is available.">
        <Toggle checked={n.builds} onChange={(builds) => update({ notifications: { ...n, builds } })} label="New builds" />
      </SettingRow>
      <SettingRow label="Harness updates" desc="When an installed harness has a new version.">
        <Toggle checked={n.runtimeUpdates} onChange={(runtimeUpdates) => update({ notifications: { ...n, runtimeUpdates } })} label="Harness updates" />
      </SettingRow>
      {/* A handful of harnesses: listed right here, not a page of their own. */}
      {n.runtimeUpdates && (
        <SettingsGroup title="Harnesses to watch">
          <ul className="pi-list" aria-label="Harnesses to announce updates for">
            {UPDATABLE_RUNTIMES.map((runtime) => {
              const on = chosen.includes(runtime);
              const name = runtimeName(runtime);
              return (
                <li key={runtime} className={cx("pi-row", !on && "pi-row-off")}>
                  <span className="rt-icon" aria-hidden>
                    <RuntimeIcon runtime={runtime} size={16} />
                  </span>
                  <span className="pi-row-text">
                    <span className="pi-row-name">{name}</span>
                  </span>
                  <Toggle checked={on} label={`Announce ${name} updates`} onChange={(next) => toggleRuntime(runtime, next)} />
                </li>
              );
            })}
          </ul>
        </SettingsGroup>
      )}
    </>
  );
}

// ------------------------------------------------------------------ General

function GeneralSection() {
  const s = useStore((st) => st.settings);
  const page = useStore((st) => st.settingsPage);
  const update = useStore((st) => st.updateSettings);
  const naming = s.naming;
  if (page === "text-generation") return <TextGeneration />;
  const names = naming.models.map((m) => planDetection(useStore.getState(), m.plan)?.models.find((x) => x.id === m.id)?.name ?? m.id);
  return (
    <>
      <Heading>General</Heading>
      <SettingRow label="Default workspace" desc="Where new threads start.">
        <OptionSelect
          label="Default workspace for new threads"
          value={s.workspace.defaultMode ?? "worktree"}
          options={[
            { value: "local", label: "Current checkout" },
            { value: "worktree", label: "New worktree" },
            { value: "last-used", label: "Last used" },
          ]}
          onChange={(defaultMode) => update({ workspace: { ...s.workspace, defaultMode } })}
        />
      </SettingRow>
      <SettingRow label="Close threads when their PR merges" hint="Pinned, snoozed and active threads stay open. A worktree is removed only when nothing would be lost.">
        <Toggle checked={s.workspace.closeMerged ?? true} onChange={(closeMerged) => update({ workspace: { ...s.workspace, closeMerged } })} label="Close threads when their PR merges" />
      </SettingRow>
      <SettingRow label="Delete worktrees of closed threads" hint="Uncommitted changes are kept.">
        <Toggle checked={s.autoDeleteWorktrees ?? false} onChange={(autoDeleteWorktrees) => update({ autoDeleteWorktrees })} label="Auto-delete worktrees" />
      </SettingRow>
      <SettingRow label="Share the stash with OpenBots">
        <Toggle checked={s.crossStash ?? false} onChange={(crossStash) => update({ crossStash })} label="Cross-stashing" />
      </SettingRow>
      <SettingRow label="Follow new output">
        <Toggle checked={s.autoScroll} onChange={(v) => update({ autoScroll: v })} label="Auto scroll" />
      </SettingRow>
      <SettingRow label="Confirm before deleting threads">
        <Toggle checked={s.confirmDelete} onChange={(v) => update({ confirmDelete: v })} label="Confirm before deleting threads" />
      </SettingRow>

      <SettingsGroup title="Text generation" className="sgroup-rows">
        <SettingRow label="Name threads automatically" desc="After their first prompt.">
          <Toggle checked={naming.enabled} onChange={(v) => update({ naming: { ...naming, enabled: v } })} label="Name threads automatically" />
        </SettingRow>
        <NavRow
          label="Models"
          desc="For thread names and commit messages."
          value={names.length ? (names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]) : "Thread’s model"}
          to="text-generation"
        />
      </SettingsGroup>

      <SettingsGroup title="Dictation" className="sgroup-rows">
        <DictationSettings />
      </SettingsGroup>
    </>
  );
}

/** Settings → General → Text generation models: the models that write thread names and commit messages (stored as `naming`), tried in order. */
function TextGeneration() {
  const naming = useStore((s) => s.settings.naming);
  const detection = useStore((s) => s.detection);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  // Reasoning levels come from runtime lists that load after this renders.
  useStore((s) => TEXT_RUNTIMES.map((r) => planDetection(s, r)?.checkedAt ?? 0).join());
  const [statuses, setStatuses] = useState<Record<ThreadRuntime, RuntimeStatus> | undefined>(() => cachedRuntimeStatuses());
  // Rows are stored as a plan: a runtime other than Pi is a plan of its own.
  const usable = TEXT_RUNTIMES.filter((r) => (r === "pi" ? !!detection.pi?.models.length : statuses?.[r]?.installed) && runtimeEnabled(settings, r, undefined, statuses));
  const runtimeOptions = (plan: TextRuntime) => [...new Set([plan, ...usable])].map((r) => ({ value: r, label: runtimeName(r), icon: <RuntimeIcon runtime={r} size={16} /> }));
  const setModels = (models: NamingModel[]) => update({ naming: { ...useStore.getState().settings.naming, models } });
  const modelsOf = (plan: TextRuntime) => planDetection(useStore.getState(), plan)?.models ?? [];

  useEffect(() => {
    void loadRuntimeStatuses().then(setStatuses).catch(() => {});
    for (const m of naming.models) void loadPlanModels(m.plan);
  }, []);

  const firstModel = async (plan: TextRuntime, taken: Set<string>): Promise<NamingModel | undefined> => {
    await loadPlanModels(plan);
    const list = modelsOf(plan).filter((m) => !taken.has(`${plan}:${m.id}`));
    const preferred = (planDetection(useStore.getState(), plan) as { defaultModel?: string } | undefined)?.defaultModel;
    const model = list.find((m) => m.id === preferred) ?? list[0];
    return model && { plan, id: model.id, effort: lowestEffort(model.reasoning.efforts) };
  };

  const addModel = async () => {
    const taken = new Set(naming.models.map((m) => `${m.plan}:${m.id}`));
    const fast = fastTarget(detection, settings);
    if (fast && !taken.has(`${fast.plan}:${fast.id}`)) {
      const model = detection[fast.plan]?.models.find((m) => m.id === fast.id);
      return setModels([...naming.models, { ...fast, effort: lowestEffort(model?.reasoning.efforts ?? []) }]);
    }
    for (const plan of usable) {
      const pick = await firstModel(plan, taken);
      if (pick) return setModels([...useStore.getState().settings.naming.models, pick]);
    }
  };

  const setRuntime = async (i: number, plan: TextRuntime) => {
    const pick = await firstModel(plan, new Set());
    if (pick) setModels(useStore.getState().settings.naming.models.map((m, j) => (j === i ? pick : m)));
  };

  return (
    <SubPage title="Text generation models" trail={["General"]}>
      <p className="subpage-desc">Write thread names and commit messages, tried in order.</p>
      <div className="naming-list">
        {!naming.models.length && <p className="naming-empty">Uses the thread’s own model.</p>}
        {naming.models.map((entry, i) => {
          const model = planDetection(useStore.getState(), entry.plan)?.models.find((m) => m.id === entry.id);
          const efforts = model?.reasoning.efforts ?? [];
          return (
            <div key={`${entry.plan}:${entry.id}:${i}`} className="naming-row">
              <span className="naming-index">{i + 1}</span>
              <ModelSelect
                label={`Text generation model ${i + 1}`}
                value={entry}
                onChange={(ref) => {
                  const next = planDetection(useStore.getState(), ref.plan)?.models.find((m) => m.id === ref.id);
                  setModels(naming.models.map((m, j) => (j === i ? { ...ref, effort: nearestEffort(next?.reasoning.efforts ?? [], m.effort) ?? m.effort } : m)));
                }}
              />
              <EffortSelect
                label={`Reasoning for text generation model ${i + 1}`}
                levels={efforts}
                value={nearestEffort(efforts, entry.effort) ?? entry.effort}
                onChange={(effort) => setModels(naming.models.map((m, j) => (j === i ? { ...m, effort } : m)))}
              />
              <OptionSelect
                label={`Harness for text generation model ${i + 1}`}
                value={entry.plan as TextRuntime}
                options={runtimeOptions(entry.plan as TextRuntime)}
                onChange={(plan) => void setRuntime(i, plan)}
              />
              <span className="naming-actions">
                {i > 0 && (
                  <IconButton
                    label="Try earlier"
                    tooltipSide="left"
                    className="key-icon-btn"
                    onClick={() => setModels(naming.models.map((m, j) => (j === i - 1 ? naming.models[i]! : j === i ? naming.models[i - 1]! : m)))}
                  >
                    <ArrowUp size={14} />
                  </IconButton>
                )}
                <IconButton label="Remove" tooltipSide="left" className="key-icon-btn key-remove" onClick={() => setModels(naming.models.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </IconButton>
              </span>
            </div>
          );
        })}
        <button type="button" className="add-key" disabled={!usable.length} onClick={() => void addModel()}>
          <Plus size={14} /> {naming.models.length ? "Add model" : "Select model"}
        </button>
        {!usable.length && <p className="naming-empty">Sign in to a provider to choose models.</p>}
      </div>
    </SubPage>
  );
}

// ------------------------------------------------------------------ Appearance

const THEMES: [Theme, string][] = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "System"],
];

/** Stored values stay as they were; the names are what the fonts are. */
const FONTS: [FontStyle, string][] = [
  ["normal", "Geist"],
  ["serif", "Serif"],
  ["fun", "Comic"],
  ["mono", "Mono"],
];

function AppearanceSection() {
  const theme = useStore((s) => s.settings.theme);
  const font = useStore((s) => s.settings.font) ?? "normal";
  const update = useStore((s) => s.updateSettings);
  return (
    <>
      <Heading>Appearance</Heading>
      <div className="setting-row setting-row-stack">
        <div className="setting-label">Theme</div>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {THEMES.map(([t, name]) => (
            <button key={t} type="button" role="radio" aria-checked={theme === t} className="segment" onClick={() => update({ theme: t })}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row setting-row-stack">
        <div className="setting-label">Font</div>
        <div className="segmented" role="radiogroup" aria-label="Font">
          {FONTS.map(([f, name]) => (
            <button key={f} type="button" role="radio" aria-checked={font === f} className={`segment segment-font-${f}`} onClick={() => update({ font: f })}>
              {name}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Security

function SecuritySection() {
  // The password is optional. With one: check it → choose the new one twice (or remove it).
  // Without one: choose it twice.
  const [configured, setConfigured] = useState<boolean>();
  const [step, setStep] = useState<"closed" | "current" | "new" | "remove">("closed");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();

  useEffect(() => {
    let active = true;
    fetch("/api/auth/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((status) => { if (active && typeof status?.configured === "boolean") setConfigured(status.configured); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const reset = (to: typeof step = "closed") => {
    setStep(to);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(undefined);
  };

  const send = async (path: string, body: object, method = "POST") => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) return true;
      setError(res.status === 403 ? "That isn't the current password." : res.status === 429 ? "Too many attempts. Wait a minute and try again." : "Couldn't reach the server. Try again.");
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
    return false;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step === "current") {
      if (await send("/api/auth/verify", { password: current })) setStep("new");
      return;
    }
    if (step === "remove") {
      if (await send("/api/auth/password", { current }, "DELETE")) {
        reset();
        setConfigured(false);
        setSaved("Password removed. Anyone who can reach this server can use it.");
      }
      return;
    }
    if (next.length < MIN_LOCAL_PASSWORD) return setError(`Use at least ${MIN_LOCAL_PASSWORD} characters.`);
    if (next !== confirm) return setError("The new passwords don't match.");
    if (await send("/api/auth/password", configured ? { current, password: next } : { password: next })) {
      reset();
      setSaved(configured ? "Password changed. Other browsers were signed out." : "Password set. Other browsers need it to get in.");
      setConfigured(true);
    }
  };

  const open = (to: typeof step) => {
    setSaved(undefined);
    reset(to);
  };

  return (
    <>
      <Heading>Security</Heading>
      <div className={step === "closed" ? "setting-row" : "setting-row setting-row-top"}>
        <div className="setting-text">
          <div className="setting-label">Instance password</div>
          <p className="setting-desc">
            {configured === false
              ? "Off. Anyone who can reach this server can run agents as its user."
              : "Required to open this instance in a new browser."}
          </p>
          {saved && step === "closed" && (
            <p className="field-help" role="status">
              {saved}
            </p>
          )}
        </div>
        {step === "closed" && configured !== undefined && (
          configured ? (
            <div className="security-actions">
              <button type="button" className="link-btn" onClick={() => open("remove")}>
                Remove
              </button>
              <button type="button" className="btn btn-sm" onClick={() => open("current")}>
                Change password
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => open("new")}>
              Set password
            </button>
          )
        )}
      </div>
      {step !== "closed" && (
        <div className="field">
          <form className="account-form" onSubmit={submit}>
            {step === "current" || step === "remove" ? (
              <Field label="Current password" htmlFor="security-current">
                <input id="security-current" className="input" type="password" autoComplete="current-password" autoFocus maxLength={1024} value={current} onChange={(e) => setCurrent(e.target.value)} />
                {step === "remove" && <p className="field-help">Without a password, anyone who can reach this server can use it.</p>}
              </Field>
            ) : (
              <>
                <Field label="New password" htmlFor="security-new">
                  <input id="security-new" className="input" type="password" autoComplete="new-password" autoFocus maxLength={1024} value={next} onChange={(e) => setNext(e.target.value)} />
                </Field>
                <Field label="Confirm new password" htmlFor="security-confirm">
                  <input id="security-confirm" className="input" type="password" autoComplete="new-password" maxLength={1024} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                  <p className="field-help">At least {MIN_LOCAL_PASSWORD} characters. Other browsers will be signed out.</p>
                </Field>
              </>
            )}
            {error && (
              <p className="account-error" role="alert">
                {error}
              </p>
            )}
            <div className="account-actions">
              <button type="submit" className="btn btn-sm" disabled={busy || (step === "current" || step === "remove" ? !current : !next || !confirm)}>
                {step === "current" ? "Continue" : step === "remove" ? "Remove password" : "Confirm"}
              </button>
              <button type="button" className="link-btn" onClick={() => reset()}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Page

const PHONE = "(max-width: 768px)";

/**
 * Settings, a page in the main pane with its own URL (/settings/<section>[/<page>]): the sections
 * beside it on a wide screen, or as its first screen on a phone. Back in its header, Esc and the
 * browser's back all go back the same way: up from a page inside a section, and out of Settings to
 * wherever it was opened from (a thread, OpenBots, Usage).
 */
export function SettingsPage() {
  const requestedSection = useStore((s) => s.settingsSection);
  const page = useStore((s) => s.settingsPage);
  const index = useStore((s) => s.settingsIndex);
  const phone = useMediaQuery(PHONE);
  const hasCloud = cloudConfigured();
  const pluginSections = usePluginSettingsSections();
  const groups: NavSection[][] = [
    ...GROUPS.map((g) => g.filter((s) => s.id !== "account" || hasCloud)),
    ...(pluginSections.length ? [pluginSections.map((p) => ({ id: p.id as SettingsSection, label: p.label, icon: Puzzle }))] : []),
  ];
  const all = groups.flat();
  const section = requestedSection === "account" && !hasCloud ? "profile" : requestedSection;
  const label = all.find((s) => s.id === section)?.label ?? "Settings";
  const root = useRef<HTMLDivElement>(null);
  // Set by the page inside a section that is open, if any (SubPage).
  const [back, setBack] = useState<SettingsBackTarget>();
  const content = useRef<HTMLDivElement>(null);
  const showIndex = phone && index;

  // On a wide screen the list is always beside the section, so a link to the list alone opens the section.
  useEffect(() => {
    if (!phone && index) useStore.setState({ settingsIndex: false });
  }, [phone, index]);

  /** One level back: out of a page inside a section, then (on a phone) to the list, then out of Settings. */
  const goBack = () => {
    if (back) back.onBack();
    else if (phone && !index) settingsUp();
    else leaveSettings();
  };
  const latest = useRef(goBack);
  latest.current = goBack;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || isShortcutRecording()) return;
      // Whatever is over the page (a dialog, a menu, a lightbox) takes its own Escape.
      if (useLightbox.getState().open || document.querySelector("dialog[open], .modal-root, .popover-portal, .context-menu")) return;
      const el = document.activeElement;
      if (el && el !== document.body && el.closest("[role='menu'], [role='listbox'], [role='dialog']")) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
  }, []);

  // Going back removes the arrow that had focus: keep focus on the page rather than lose it.
  useLayoutEffect(() => {
    if (document.activeElement === document.body) root.current?.focus({ preventScroll: true });
  }, [back, section, index]);

  // Into a page or back out of it, what shows next starts at its top, not at the offset the last one was
  // scrolled to; opened again where it was left (settingsPlace.ts), it goes back to how far down it was.
  // That page may still be filling in (a list loading), so it keeps trying for a moment until it fits.
  const restoring = useRef<{ section: SettingsSection; page?: string; scroll: number; until: number }>(undefined);
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const want = takeSettingsScroll(section, page);
    if (want !== undefined) restoring.current = { section, page, scroll: want, until: performance.now() + 1500 };
    const r = restoring.current;
    if (!r || r.section !== section || r.page !== page || performance.now() > r.until) {
      restoring.current = undefined;
      el.scrollTop = 0;
      return;
    }
    let frame = 0;
    const put = () => {
      if (restoring.current !== r) return;
      el.scrollTop = r.scroll;
      if (Math.abs(el.scrollTop - r.scroll) > 1 && performance.now() < r.until) frame = requestAnimationFrame(put);
    };
    // Scrolling meanwhile is the user's: stop putting it back.
    const stop = () => (restoring.current = undefined);
    el.addEventListener("wheel", stop, { once: true, passive: true });
    el.addEventListener("touchstart", stop, { once: true, passive: true });
    put();
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
    };
  }, [section, page, !!back]);

  // Closing, it notes where it was, for opening again soon after.
  const here = useRef({ section, page, index });
  here.current = { section, page, index };
  useLayoutEffect(() => () => leaveSettingsAt({ ...here.current, scroll: content.current?.scrollTop ?? 0 }), []);

  const title = phone ? (back?.title ?? (showIndex ? "Settings" : label)) : "Settings";
  const backLabel = phone ? (back ? back.label : index ? "Back" : "Back to Settings") : "Back";

  return (
    <div ref={root} className={cx("spage", showIndex && "spage-index", back && "has-back")} role="region" aria-label="Settings" tabIndex={-1}>
      <PageHeader title={title} backLabel={backLabel} onBack={phone ? goBack : leaveSettings} />
      <div className="spage-body">
        {(!phone || showIndex) && (
          <nav className="settings-nav" aria-label="Settings sections" onKeyDown={(e) => arrowNav(e)}>
            {groups.map((group, i) => (
              <div key={i} className="settings-nav-group">
                {group.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="settings-nav-item"
                    aria-current={!showIndex && section === s.id}
                    aria-label={s.label}
                    onClick={() => openSettingsSection(s.id)}
                  >
                    <s.icon size={20} className="settings-nav-icon" aria-hidden />
                    <span className="settings-nav-label">{s.label}</span>
                    {showIndex && <ChevronRight size={16} className="settings-nav-chevron" aria-hidden />}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}
        {!showIndex && (
          <SettingsBackContext.Provider value={setBack}>
            <div ref={content} className="settings-content">
              <div className="settings-inner" key={section}>
                {section === "profile" && <ProfileSection />}
                {section === "security" && <SecuritySection />}
                {hasCloud && section === "account" && (
                  <>
                    <Heading>Account</Heading>
                    <AccountSection />
                  </>
                )}
                {section === "general" && <GeneralSection />}
                {section === "bots" && <BotsSettingsSection />}
                {section === "shortcuts" && <ShortcutsSection />}
                {section === "pi" && <PiSection />}
                {section === "keys" && <ProvidersSection />}
                {section === "runtimes" && <RuntimesSection />}
                {section === "projects" && <ProjectsSection />}
                {section === "devices" && <DevicesSection />}
                {section === "appearance" && (
                  <>
                    <AppearanceSection />
                    <PluginSlot name="settings:appearance:after" />
                  </>
                )}
                {section === "notifications" && <NotificationsSection />}
                {section === "plugins" && <PluginsSection />}
                {pluginSections.some((p) => p.id === section) && <PluginSettingsPage section={section} />}
              </div>
            </div>
          </SettingsBackContext.Provider>
        )}
      </div>
    </div>
  );
}
