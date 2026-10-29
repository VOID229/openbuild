import { ArrowUp, Bell, CircleUser, FolderGit2, Key, Keyboard, Palette, Pencil, Plus, Puzzle, Settings2, Shield, SquareTerminal, Trash2, UserRound, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { lowestEffort, nearestEffort } from "../../shared/types";
import { cloudConfigured } from "../lib/cloud";
import { fastTarget, findModel } from "../lib/models";
import { useStore, type SettingsSection } from "../lib/store";
import type { FontStyle, NamingModel, Theme } from "../lib/types";
import { arrowNav, usePresence } from "../lib/ui";
import { AccountSection } from "./Account";
import { DictationSettings } from "./DictationSettings";
import { PiSection, ProjectsSection, ProvidersSection } from "./PiSettings";
import { EffortSelect, ModelSelect, OptionSelect } from "./ModelSelect";
import { Avatar, IconButton, SettingsHeading, Toggle } from "./primitives";
import { ShortcutsSection } from "./ShortcutSettings";
import { PluginSettingsPage, PluginSlot, usePluginSettingsSections } from "../lib/plugins";
import { PluginsSection } from "./PluginSettings";

/** Icons stand in for the labels on phones, so every section fits without scrolling. */
const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "general", label: "General", icon: Settings2 },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "pi", label: "Pi", icon: SquareTerminal },
  { id: "keys", label: "Providers", icon: Key },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "security", label: "Security", icon: Shield },
  { id: "account", label: "Account", icon: CircleUser },
];

const Heading = SettingsHeading;
const MIN_LOCAL_PASSWORD = 4;

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="md-label" htmlFor={htmlFor}>
        <span className="md-hash">#</span>
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
        <Avatar src={profile.avatar} name={profile.name} size={88} />
        <button type="button" className="avatar-pencil" aria-label="Change photo" data-tooltip="Change photo" onClick={() => file.current?.click()}>
          <Pencil size={14} />
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
      <Field label="Bio" htmlFor="profile-bio">
        <textarea
          id="profile-bio"
          className="input textarea"
          rows={4}
          value={profile.bio}
         
          onChange={(e) => updateProfile({ bio: e.target.value })}
        />
        <p className="field-help">Shared with the model as context, so preferences here shape its answers.</p>
      </Field>
      <Field label="Location" htmlFor="profile-location">
        <input id="profile-location" className="input" value={profile.location} onChange={(e) => updateProfile({ location: e.target.value })} />
      </Field>
      <Field label="language" htmlFor="profile-language">
        <input id="profile-language" className="input" value={profile.language} onChange={(e) => updateProfile({ language: e.target.value })} />
      </Field>
    </>
  );
}

// ------------------------------------------------------------------ Notifications

function NotificationsSection() {
  const n = useStore((st) => st.settings.notifications);
  const update = useStore((st) => st.updateSettings);
  return (
    <>
      <Heading>Notifications</Heading>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">New Builds</div>
          <p className="setting-desc">Offer a reload when the OpenBuild server is running newer code than this window, e.g. after a pull and restart.</p>
        </div>
        <Toggle checked={n.builds} onChange={(builds) => update({ notifications: { ...n, builds } })} label="New Builds" />
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Pi Updates</div>
          <p className="setting-desc">Show when a newer Pi is out for this computer. Closing the notice skips that release.</p>
        </div>
        <Toggle checked={n.piUpdates} onChange={(piUpdates) => update({ notifications: { ...n, piUpdates } })} label="Pi Updates" />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ General

function GeneralSection() {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  return (
    <>
      <Heading>General</Heading>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Default workspace</div>
          <p className="setting-desc">Choose where new threads start. You can still change this above the composer.</p>
        </div>
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
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Enable Auto Scroll</div>
        </div>
        <Toggle checked={s.autoScroll} onChange={(v) => update({ autoScroll: v })} label="Enable Auto Scroll" />
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Confirm Before Deleting Threads</div>
          <p className="setting-desc">Ask before a thread is deleted from the sidebar.</p>
        </div>
        <Toggle checked={s.confirmDelete} onChange={(v) => update({ confirmDelete: v })} label="Confirm Before Deleting Threads" />
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Require Cmd+Enter To Submit</div>
          <p className="setting-desc">
            When enabled, press Cmd+Enter (or Ctrl+Enter) to submit.
            <br />
            Enter will add a new line.
          </p>
        </div>
        <Toggle checked={s.cmdEnter} onChange={(v) => update({ cmdEnter: v })} label="Require Cmd+Enter To Submit" />
      </div>
      <DictationSettings />
      <TextGeneration />
    </>
  );
}

/** Settings → General: the models that write thread names and commit messages (stored as `naming`). */
function TextGeneration() {
  const naming = useStore((s) => s.settings.naming);
  const detection = useStore((s) => s.detection);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const plans = (["pi"] as const).filter((p) => detection[p]?.models.length);
  const setModels = (models: NamingModel[]) => update({ naming: { ...naming, models } });

  const addModel = () => {
    const taken = new Set(naming.models.map((m) => `${m.plan}:${m.id}`));
    const fast = fastTarget(detection, settings);
    const pick =
      fast && !taken.has(`${fast.plan}:${fast.id}`)
        ? fast
        : plans.flatMap((plan) => (detection[plan]?.models ?? []).map((m) => ({ plan, id: m.id }))).find((m) => !taken.has(`${m.plan}:${m.id}`));
    if (!pick) return;
    const model = findModel(detection, pick);
    setModels([...naming.models, { ...pick, effort: lowestEffort(model?.reasoning.efforts ?? []) }]);
  };

  return (
    <>
      <div className="setting-row setting-row-top setting-row-divided">
        <div className="setting-text">
          <div className="setting-label">Text generation models</div>
          <p className="setting-desc">Used for thread names and commit messages. Tried top to bottom; if one fails, the next is used.</p>
        </div>
      </div>
      <div className="naming-list">
        {!naming.models.length && <p className="naming-empty">Uses the thread's own model at its lowest reasoning. Select models to override.</p>}
        {naming.models.map((entry, i) => {
          const model = findModel(detection, entry);
          const efforts = model?.reasoning.efforts ?? [];
          return (
            <div key={`${entry.plan}:${entry.id}:${i}`} className="naming-row">
              <span className="naming-index">{i + 1}</span>
              <ModelSelect
                label={`Text generation model ${i + 1}`}
                value={entry}
                onChange={(ref) => {
                  const next = findModel(detection, ref);
                  setModels(naming.models.map((m, j) => (j === i ? { ...ref, effort: nearestEffort(next?.reasoning.efforts ?? [], m.effort) ?? m.effort } : m)));
                }}
              />
              <EffortSelect
                label={`Reasoning for text generation model ${i + 1}`}
                levels={efforts}
                value={nearestEffort(efforts, entry.effort) ?? entry.effort}
                onChange={(effort) => setModels(naming.models.map((m, j) => (j === i ? { ...m, effort } : m)))}
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
        <button type="button" className="add-key" disabled={!plans.length} onClick={addModel}>
          <Plus size={14} /> {naming.models.length ? "add model" : "select model"}
        </button>
        {!plans.length && <p className="naming-empty">Sign in to a provider in Settings → Providers to choose models.</p>}
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Name threads automatically</div>
          <p className="setting-desc">Give each new thread a title after its first prompt.</p>
        </div>
        <Toggle checked={naming.enabled} onChange={(v) => update({ naming: { ...naming, enabled: v } })} label="Name threads automatically" />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Appearance

function AppearanceSection() {
  const theme = useStore((s) => s.settings.theme);
  const font = useStore((s) => s.settings.font) ?? "fun";
  const update = useStore((s) => s.updateSettings);
  return (
    <>
      <Heading>Appearance</Heading>
      <div className="setting-row setting-row-stack">
        <div className="setting-label">Theme</div>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(["light", "dark", "system"] as Theme[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={theme === t} className="segment" onClick={() => update({ theme: t })}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row setting-row-stack">
        <div className="setting-label">Font</div>
        <div className="segmented" role="radiogroup" aria-label="Font">
          {(["normal", "serif", "fun", "mono"] as FontStyle[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={font === f} className="segment" onClick={() => update({ font: f })}>
              {f}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Security

function SecuritySection() {
  // Closed → check the current password → choose the new one twice.
  const [step, setStep] = useState<"closed" | "current" | "new">("closed");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const reset = (to: typeof step = "closed") => {
    setStep(to);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(undefined);
  };

  const post = async (path: string, body: object) => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
      if (await post("/api/auth/verify", { password: current })) setStep("new");
      return;
    }
    if (next.length < MIN_LOCAL_PASSWORD) return setError(`Use at least ${MIN_LOCAL_PASSWORD} characters.`);
    if (next !== confirm) return setError("The new passwords don't match.");
    if (await post("/api/auth/password", { current, password: next })) {
      reset();
      setSaved(true);
    }
  };

  return (
    <>
      <Heading>Security</Heading>
      <div className="field">
        <div className="setting-label">Instance password</div>
        <p className="setting-desc">This instance is protected by a server password, not a cloud account. Unlocked browsers can run Pi as the server user.</p>
        {step === "closed" ? (
          <>
            <div className="account-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSaved(false);
                  reset("current");
                }}
              >
                Change password
              </button>
              {saved && <span className="field-help" role="status">Password changed.</span>}
            </div>
            <p className="field-help">
              Changing the password signs out every other browser. On the host computer you can also run <code>openbuild set pass &lt;password&gt;</code>.
            </p>
          </>
        ) : (
          <form className="account-form" onSubmit={submit}>
            {step === "current" ? (
              <Field label="Current password" htmlFor="security-current">
                <input id="security-current" className="input" type="password" autoComplete="current-password" autoFocus maxLength={1024} value={current} onChange={(e) => setCurrent(e.target.value)} />
              </Field>
            ) : (
              <>
                <Field label="New password" htmlFor="security-new">
                  <input id="security-new" className="input" type="password" autoComplete="new-password" autoFocus maxLength={1024} value={next} onChange={(e) => setNext(e.target.value)} />
                </Field>
                <Field label="Confirm new password" htmlFor="security-confirm">
                  <input id="security-confirm" className="input" type="password" autoComplete="new-password" maxLength={1024} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                  <p className="field-help">At least {MIN_LOCAL_PASSWORD} characters. Every other browser will be signed out.</p>
                </Field>
              </>
            )}
            {error && (
              <p className="account-error" role="alert">
                {error}
              </p>
            )}
            <div className="account-actions">
              <button type="submit" className="btn" disabled={busy || (step === "current" ? !current : !next || !confirm)}>
                {step === "current" ? "Continue" : "Confirm"}
              </button>
              <button type="button" className="link-btn" onClick={() => reset()}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Modal

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const requestedSection = useStore((s) => s.settingsSection);
  const hasCloud = cloudConfigured();
  const pluginSections = usePluginSettingsSections();
  const sections: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
    ...SECTIONS.filter((s) => s.id !== "account" || hasCloud),
    ...pluginSections.map((p) => ({ id: p.id as SettingsSection, label: p.label, icon: Puzzle })),
  ];
  const section = requestedSection === "account" && !hasCloud ? "profile" : requestedSection;
  const close = useStore((s) => s.closeSettings);
  const { mounted, visible } = usePresence(open, 220);
  const dialog = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab" && dialog.current) {
        // Keep focus inside the dialog.
        const items = dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not([type="hidden"]), textarea, a[href], [tabindex]:not([tabindex="-1"])');
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreFocus.current?.focus?.();
    };
  }, [open, close]);

  useEffect(() => {
    if (open && mounted) dialog.current?.focus({ preventScroll: true });
  }, [open, mounted]);

  if (!mounted) return null;
  return (
    <div className="modal-root" data-state={visible ? "open" : "closed"}>
      <div className="modal-backdrop" onClick={close} aria-hidden />
      <div ref={dialog} className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <nav className="settings-nav" aria-label="Settings sections" onKeyDown={(e) => arrowNav(e)}>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className="settings-nav-item"
              aria-current={section === s.id}
              aria-label={s.label}
              onClick={() => useStore.setState({ settingsSection: s.id })}
            >
              <s.icon size={20} className="settings-nav-icon" aria-hidden />
              <span className="settings-nav-label">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-content" key={section}>
          {section === "profile" && <ProfileSection />}
          {section === "security" && <SecuritySection />}
          {hasCloud && section === "account" && (
            <>
              <Heading>Account</Heading>
              <AccountSection />
            </>
          )}
          {section === "general" && <GeneralSection />}
          {section === "shortcuts" && <ShortcutsSection />}
          {section === "pi" && <PiSection />}
          {section === "keys" && <ProvidersSection />}
          {section === "projects" && <ProjectsSection />}
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
        <IconButton label="Close settings" tooltip={false} className="modal-close" onClick={close}>
          <X size={18} />
        </IconButton>
      </div>
    </div>
  );
}
