import { ArrowUp, Check, CircleAlert, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { KEY_ORDER, nearestEffort, PLANS, type PlanId } from "../../shared/types";
import { keyId } from "../lib/keys";
import { fastTarget, findModel, isFastModel } from "../lib/models";
import { useStore, type SettingsSection } from "../lib/store";
import type { NamedModel, NamingModel, Theme } from "../lib/types";
import { arrowNav, cx, usePresence } from "../lib/ui";
import { EffortSelect, ModelSelect } from "./ModelSelect";
import { Avatar, BrandIcon, IconButton, Popover, Spinner, Toggle } from "./primitives";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "general", label: "General" },
  { id: "keys", label: "API Keys" },
  { id: "appearance", label: "Appearance" },
];

const Heading = ({ children }: { children: ReactNode }) => (
  <h2 className="md-h1" id="settings-title">
    <span className="md-hash">#</span> {children}
  </h2>
);

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

// ------------------------------------------------------------------ General

function useAllModels(): NamedModel[] {
  const detection = useStore((s) => s.detection);
  return useMemo(() => {
    const seen = new Map<string, NamedModel>();
    for (const d of Object.values(detection)) for (const m of d?.models ?? []) if (!seen.has(m.id)) seen.set(m.id, { id: m.id, name: m.name });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [detection]);
}

function AddModel({ exclude, onAdd, label }: { exclude: string[]; onAdd: (m: NamedModel) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const all = useAllModels();
  const options = all.filter((m) => !exclude.includes(m.id) && (m.name + m.id).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 50);
  const add = (m: NamedModel) => {
    onAdd(m);
    setQ("");
    setOpen(false);
  };
  return (
    <span className="picker">
      <button ref={anchor} type="button" className="chip chip-add" aria-label={label} data-tooltip={open ? undefined : label} onClick={() => setOpen((o) => !o)}>
        <Plus size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu add-model drop-up" label={label} fixed="up">
        <input
          autoFocus
          className="input input-sm"
          placeholder="Search models…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const first = options[0];
              if (first) add(first);
              else if (q.trim()) add({ id: q.trim(), name: q.trim() });
            }
          }}
        />
        <div className="add-model-list" onKeyDown={(e) => arrowNav(e)}>
          {options.map((m) => (
            <button key={m.id} type="button" className="menu-item" onClick={() => add(m)}>
              <BrandIcon id={m.id} />
              <span className="menu-item-label">{m.name}</span>
            </button>
          ))}
          {!options.length && q.trim() && (
            <button type="button" className="menu-item" onClick={() => add({ id: q.trim(), name: q.trim() })}>
              <Plus size={14} /> Add “{q.trim()}”
            </button>
          )}
          {!options.length && !q.trim() && <p className="menu-empty">Add an API key to pick from detected models.</p>}
        </div>
      </Popover>
    </span>
  );
}

function GeneralSection() {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  return (
    <>
      <Heading>General</Heading>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Enable Auto Scroll</div>
        </div>
        <Toggle checked={s.autoScroll} onChange={(v) => update({ autoScroll: v })} label="Enable Auto Scroll" />
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
      <div className="setting-row setting-row-top">
        <div className="setting-text">
          <div className="setting-label">
            Auto model router <span className="caption">*experimental</span>
          </div>
          <p className="setting-desc">
            Automatically route requests to the right model for the cheapest options that fit the quality required for the prompt.
          </p>
          <p className="setting-desc">
            easier questions go to faster and cheaper models, while more complex questions such as code, math, and science related questions will be
            routed to higher quality models.
          </p>
        </div>
        <Toggle checked={s.autoRouter} onChange={(v) => update({ autoRouter: v })} label="Auto model router" />
      </div>
      <div className={cx("router-config", !s.autoRouter && "router-config-hidden")} inert={!s.autoRouter}>
        <div className="router-config-inner">
          <div className="chip-group">
            <div className="chip-group-label">models to avoid:</div>
            <div className="chips">
              {s.avoid.map((m) => (
                <span key={m.id} className="chip">
                  {m.name}
                  <button type="button" className="chip-x" aria-label={`Remove ${m.name}`} onClick={() => update({ avoid: s.avoid.filter((x) => x.id !== m.id) })}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              <AddModel label="Add a model to avoid" exclude={s.avoid.map((m) => m.id)} onAdd={(m) => update({ avoid: [...s.avoid, m] })} />
            </div>
          </div>
          <div className="chip-group">
            <div className="chip-group-label">models to prioritize:</div>
            <div className="chips">
              {s.prioritize.map((p, i) => (
                <span key={p.id} className="chip-pair">
                  <span className="chip">
                    {p.name}
                    <button
                      type="button"
                      className="chip-x"
                      aria-label={`Remove ${p.name}`}
                      onClick={() => update({ prioritize: s.prioritize.filter((x) => x.id !== p.id) })}
                    >
                      <X size={12} />
                    </button>
                  </span>
                  <span className="chip-link" aria-hidden />
                  <button
                    type="button"
                    className="chip chip-tag"
                    data-tooltip="Click to switch between Speed and complex"
                    onClick={() =>
                      update({ prioritize: s.prioritize.map((x) => (x.id === p.id ? { ...x, tag: x.tag === "Speed" ? "complex" : "Speed" } : x)) })
                    }
                  >
                    {p.tag}
                  </button>
                  {i < s.prioritize.length - 1 && <span className="chip-comma">,</span>}
                </span>
              ))}
              <AddModel
                label="Add a model to prioritize"
                exclude={s.prioritize.map((m) => m.id)}
                onAdd={(m) => update({ prioritize: [...s.prioritize, { ...m, tag: isFastModel(m, { prioritize: [] }) ? "Speed" : "complex" }] })}
              />
            </div>
          </div>
        </div>
      </div>
      <ChatNaming />
    </>
  );
}

function ChatNaming() {
  const naming = useStore((s) => s.settings.naming);
  const detection = useStore((s) => s.detection);
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const plans = KEY_ORDER.filter((p) => detection[p]?.models.length);
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
    setModels([...naming.models, { ...pick, effort: nearestEffort(model?.reasoning.efforts ?? [], "low") ?? "low" }]);
  };

  return (
    <>
      <div className="setting-row setting-row-top setting-row-divided">
        <div className="setting-text">
          <div className="setting-label">Chat naming</div>
          <p className="setting-desc">Name new chats automatically after the first reply. Models are tried from top to bottom; if one fails, the next one is used.</p>
        </div>
        <Toggle checked={naming.enabled} onChange={(v) => update({ naming: { ...naming, enabled: v } })} label="Chat naming" />
      </div>
      <div className={cx("router-config", !naming.enabled && "router-config-hidden")} inert={!naming.enabled}>
        <div className="router-config-inner">
          <div className="naming-list">
            {!naming.models.length && <p className="naming-empty">Using the fastest available model. Add models to choose which ones name your chats.</p>}
            {naming.models.map((entry, i) => {
              const model = findModel(detection, entry);
              const efforts = model?.reasoning.efforts ?? [];
              return (
                <div key={`${entry.plan}:${entry.id}:${i}`} className="naming-row">
                  <span className="naming-index">{i + 1}</span>
                  <ModelSelect
                    label={`Naming model ${i + 1}`}
                    value={entry}
                    onChange={(ref) => {
                      const next = findModel(detection, ref);
                      setModels(naming.models.map((m, j) => (j === i ? { ...ref, effort: nearestEffort(next?.reasoning.efforts ?? [], m.effort) ?? m.effort } : m)));
                    }}
                  />
                  <EffortSelect
                    label={`Reasoning for naming model ${i + 1}`}
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
              <Plus size={14} /> {naming.models.length ? "add fallback" : "add model"}
            </button>
            {!plans.length && <p className="naming-empty">Add an API key to choose naming models.</p>}
          </div>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ API Keys

const MASK = "*".repeat(34);

interface KeyFieldProps {
  plan: PlanId;
  /** Saved key; undefined for a new, unsaved field. */
  value?: string;
  index: number;
  total: number;
  autoFocus?: boolean;
  onSave: (key: string) => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  /** New fields only: discard the empty field. */
  onCancel?: () => void;
}

function KeyField({ plan, value, index, total, autoFocus, onSave, onRemove, onMoveUp, onCancel }: KeyFieldProps) {
  const status = useStore((s) => (value ? s.detection[plan]?.keys?.[keyId(value)] : undefined));
  const refreshDetection = useStore((s) => s.refreshDetection);
  const [editing, setEditing] = useState(!value);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const label = PLANS[plan].label;
  const id = `key-${plan}-${index}`;
  const actionId = `${plan}-${index}`;

  useEffect(() => {
    if (autoFocus) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replace = () => {
    setEditing(true);
    setDraft("");
    requestAnimationFrame(() => input.current?.focus());
  };
  const save = () => {
    if (!draft.trim()) return;
    onSave(draft.trim());
    setDraft("");
    if (value) setEditing(false);
  };
  const cancel = () => {
    setDraft("");
    if (value) setEditing(false);
    else onCancel?.();
  };

  let line: ReactNode = null;
  if (value && status) {
    if (status.status === "checking") line = (<><Spinner size={12} /> Detecting models…</>);
    else if (status.status === "valid") line = (<><Check size={13} className="ok" /> {status.models ?? 0} models available</>);
    else if (status.status === "invalid") line = (<><CircleAlert size={13} className="bad" /> Invalid API key — replace it to continue</>);
    else
      line = (
        <>
          <CircleAlert size={13} className="bad" /> {status.error ?? "Couldn't verify this key"}
          <button type="button" className="link-btn" onClick={() => refreshDetection(plan)}>
            <RefreshCw size={12} /> Retry
          </button>
        </>
      );
  }

  return (
    <div className="key-entry">
      {total > 1 && (
        <div className="key-caption">
          Key {index + 1}
          <span>{index === 0 ? "primary" : "fallback"}</span>
        </div>
      )}
      <div className="key-entry-row">
        <input
          ref={input}
          id={id}
          className={cx("input key-input", !editing && "key-input-masked")}
          type={editing ? "password" : "text"}
          readOnly={!editing}
          value={editing ? draft : MASK}
          placeholder={index === 0 ? `Paste your ${label} key` : `Paste another ${label} key`}
          aria-label={total > 1 ? `${label} key ${index + 1}` : `${label} key`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape" && editing && (value || onCancel)) {
              e.stopPropagation();
              cancel();
            }
          }}
          onBlur={(e) => {
            // Leaving the field without a value restores the saved key (or drops an empty new field).
            if (!draft.trim() && e.relatedTarget?.getAttribute("data-key-action") !== actionId && (value || onCancel)) cancel();
          }}
          onFocus={() => !editing && replace()}
        />
        <div className="key-actions">
          {editing ? (
            <button type="button" className="btn btn-sm" data-key-action={actionId} disabled={!draft.trim()} onClick={save}>
              save
            </button>
          ) : (
            <button type="button" className="btn btn-sm" data-key-action={actionId} onClick={replace}>
              replace
            </button>
          )}
          {onMoveUp && !editing && (
            <IconButton label="Use before the key above" tooltipSide="left" className="key-icon-btn" onClick={onMoveUp}>
              <ArrowUp size={14} />
            </IconButton>
          )}
          {onRemove && !editing && (
            <IconButton label="Remove key" tooltipSide="left" className="key-icon-btn key-remove" onClick={onRemove}>
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>
      {line && <div className={cx("key-status", status?.status === "invalid" && "key-status-bad")}>{line}</div>}
    </div>
  );
}

function PlanKeys({ plan, autoFocus }: { plan: PlanId; autoFocus: boolean }) {
  const keys = useStore((s) => s.settings.keys[plan]) ?? [];
  const setKeys = useStore((s) => s.setKeys);
  const [adding, setAdding] = useState(false);
  const total = keys.length + (adding ? 1 : 0);

  const update = (next: string[]) => setKeys(plan, next);
  return (
    <div className="key-row">
      <div className="key-label">{PLANS[plan].label}</div>
      <div className="key-fields">
        {keys.map((k, i) => (
          <KeyField
            key={keyId(k)}
            plan={plan}
            value={k}
            index={i}
            total={total}
            onSave={(next) => update(keys.map((x, j) => (j === i ? next : x)))}
            onRemove={() => update(keys.filter((_, j) => j !== i))}
            onMoveUp={i > 0 ? () => update(keys.map((x, j) => (j === i - 1 ? keys[i]! : j === i ? keys[i - 1]! : x))) : undefined}
          />
        ))}
        {(adding || !keys.length) && (
          <KeyField
            key={`new-${keys.length}`}
            plan={plan}
            index={keys.length}
            total={total || 1}
            autoFocus={adding || autoFocus}
            onSave={(next) => {
              update([...keys, next]);
              setAdding(false);
            }}
            onCancel={keys.length ? () => setAdding(false) : undefined}
          />
        )}
        {keys.length > 0 && !adding && (
          <button type="button" className="add-key" onClick={() => setAdding(true)}>
            <Plus size={14} /> add more
          </button>
        )}
      </div>
    </div>
  );
}

function KeysSection() {
  const keys = useStore((s) => s.settings.keys);
  const firstEmpty = Object.keys(keys).length === 0;
  return (
    <>
      <Heading>API Keys</Heading>
      <div className="key-list">
        {KEY_ORDER.map((plan, i) => (
          <PlanKeys key={plan} plan={plan} autoFocus={firstEmpty && i === 0} />
        ))}
      </div>
      <p className="field-help keys-help">
        Add more than one key per plan and OpenChat falls back to the next one if a key is rejected, out of credit, or rate limited. Keys stay in
        this browser and are only sent to Opencode through your local OpenChat server. Get one at{" "}
        <a href="https://opencode.ai/auth" target="_blank" rel="noopener noreferrer">
          opencode.ai
        </a>
        .
      </p>
    </>
  );
}

// ------------------------------------------------------------------ Appearance

function AppearanceSection() {
  const theme = useStore((s) => s.settings.theme);
  const update = useStore((s) => s.updateSettings);
  return (
    <>
      <Heading>Appearance</Heading>
      <div className="setting-row">
        <div className="setting-label">Theme</div>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(["light", "dark", "system"] as Theme[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={theme === t} className="segment" onClick={() => update({ theme: t })}>
              {t}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Modal

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const section = useStore((s) => s.settingsSection);
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
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="settings-nav-item"
              aria-current={section === s.id}
              onClick={() => useStore.setState({ settingsSection: s.id })}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-content" key={section}>
          {section === "profile" && <ProfileSection />}
          {section === "general" && <GeneralSection />}
          {section === "keys" && <KeysSection />}
          {section === "appearance" && <AppearanceSection />}
        </div>
        <IconButton label="Close settings" tooltip={false} className="modal-close" onClick={close}>
          <X size={18} />
        </IconButton>
      </div>
    </div>
  );
}
