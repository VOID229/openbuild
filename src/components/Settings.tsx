import { ArrowUp, Check, CircleAlert, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { KEY_ORDER, nearestEffort, PLANS, SEARCH_ORDER, SEARCH_PROVIDERS, type KeyEdit, type PlanId, type SearchProviderId } from "../../shared/types";
import { keyId } from "../lib/keys";
import { fastTarget, findModel, isFastModel } from "../lib/models";
import { parseModelQuery, scoreModel } from "../lib/modelSearch";
import { useStore, type SettingsSection } from "../lib/store";
import type { FontStyle, KeyStatus, NamedModel, NamingModel, Theme } from "../lib/types";
import { arrowNav, cx, useFocusOnShow, usePresence } from "../lib/ui";
import { AccountSection } from "./Account";
import { EffortSelect, ModelSelect } from "./ModelSelect";
import { Avatar, BrandIcon, IconButton, Popover, Spinner, Toggle } from "./primitives";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "account", label: "Account" },
  { id: "general", label: "General" },
  { id: "keys", label: "API Keys" },
  { id: "search", label: "Web Search" },
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

/** Every detected model once, with the plans it's available on. */
function useAllModels(): (NamedModel & { plans: PlanId[] })[] {
  const detection = useStore((s) => s.detection);
  return useMemo(() => {
    const seen = new Map<string, NamedModel & { plans: PlanId[] }>();
    for (const plan of KEY_ORDER)
      for (const m of detection[plan]?.models ?? []) {
        const entry = seen.get(m.id) ?? { id: m.id, name: m.name, plans: [] };
        entry.plans.push(plan);
        seen.set(m.id, entry);
      }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [detection]);
}

/** Search input that focuses itself each time its popover opens. */
function PopoverSearch(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const ref = useRef<HTMLInputElement>(null);
  useFocusOnShow(ref);
  return <input ref={ref} {...props} />;
}

function AddModel({ exclude, onAdd, label }: { exclude: string[]; onAdd: (m: NamedModel) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const all = useAllModels();
  // Same search as the model pickers: "go deepseek" → DeepSeek models on the Go key.
  const options = useMemo(() => {
    const parsed = parseModelQuery(q);
    const pool = all.filter((m) => !exclude.includes(m.id));
    if (!parsed.raw) return pool.slice(0, 50);
    return pool
      .map((m) => ({ m, s: scoreModel(m, m.plans, parsed) }))
      .filter((x) => x.s !== undefined)
      .sort((a, b) => b.s! - a.s!)
      .slice(0, 50)
      .map((x) => x.m);
  }, [all, exclude, q]);
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
        <PopoverSearch
          className="input input-sm"
          placeholder="Search models, or go / zen / plus / black…"
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
  /** Unique per list, e.g. a plan id or `search-exa`. */
  scope: string;
  /** Provider name, e.g. "Opencode Go" or "Exa". */
  label: string;
  /** "url" fields show their saved value and are edited in place instead of masked and replaced. */
  kind?: "key" | "url";
  /** Saved key; undefined for a new, unsaved field. */
  value?: string;
  index: number;
  total: number;
  autoFocus?: boolean;
  status?: KeyStatus;
  /** What the status check does: list the plan's models, or run a test search. */
  verifies?: "models" | "search";
  onRetry?: () => void;
  /** Return an error message to reject a draft. */
  validate?: (draft: string) => string | undefined;
  onSave: (key: string) => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  /** New fields only: discard the empty field. */
  onCancel?: () => void;
}

function KeyField({ scope, label, kind = "key", value, index, total, autoFocus, status, verifies = "models", onRetry, validate, onSave, onRemove, onMoveUp, onCancel }: KeyFieldProps) {
  const [editing, setEditing] = useState(!value);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const isUrl = kind === "url";
  const noun = isUrl ? "URL" : "key";
  const id = `key-${scope}-${index}`;
  const actionId = `${scope}-${index}`;

  useEffect(() => {
    if (autoFocus) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replace = () => {
    setEditing(true);
    // URLs aren't secret: edit the saved value rather than retyping it.
    setDraft(isUrl ? (value ?? "") : "");
    requestAnimationFrame(() => (isUrl ? input.current?.select() : input.current?.focus()));
  };
  const save = () => {
    const next = draft.trim();
    if (!next) return;
    const error = validate?.(next);
    setInvalid(error);
    if (error) return;
    if (next !== value) onSave(next);
    setDraft("");
    if (value) setEditing(false);
  };
  const cancel = () => {
    setDraft("");
    setInvalid(undefined);
    if (value) setEditing(false);
    else onCancel?.();
  };

  let line: ReactNode = null;
  if (invalid) line = (<><CircleAlert size={13} className="bad" /> {invalid}</>);
  else if (value && status && !editing) {
    if (status.status === "checking") line = (<><Spinner size={12} /> {verifies === "search" ? `Checking ${isUrl ? "instance" : "key"}…` : "Detecting models…"}</>);
    else if (status.status === "valid")
      line = (<><Check size={13} className="ok" /> {verifies === "search" ? (isUrl ? "Instance reachable" : "Key works") : `${status.models ?? 0} models available`}</>);
    else if (status.status === "invalid")
      line = (<><CircleAlert size={13} className="bad" /> {verifies === "search" ? `${status.error ?? `Invalid ${noun}`}: ${isUrl ? "edit" : "replace"} it to continue` : "Invalid API key — replace it to continue"}</>);
    else
      line = (
        <>
          <CircleAlert size={13} className="bad" /> {status.error ?? `Couldn't verify this ${noun}`}
          {onRetry && (
            <button type="button" className="link-btn" onClick={onRetry}>
              <RefreshCw size={12} /> Retry
            </button>
          )}
        </>
      );
  }

  return (
    <div className="key-entry">
      {total > 1 && (
        <div className="key-caption">
          {isUrl ? "Instance" : "Key"} {index + 1}
          <span>{index === 0 ? "primary" : "fallback"}</span>
        </div>
      )}
      <div className="key-entry-row">
        <input
          ref={input}
          id={id}
          className={cx("input key-input", !editing && "key-input-masked")}
          type={editing && !isUrl ? "password" : "text"}
          inputMode={isUrl ? "url" : undefined}
          readOnly={!editing}
          value={editing ? draft : isUrl ? value : MASK}
          placeholder={isUrl ? "http://192.168.1.10:8080" : index === 0 ? `Paste your ${label} key` : `Paste another ${label} key`}
          aria-label={total > 1 ? `${label} ${noun} ${index + 1}` : `${label} ${noun}`}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(undefined);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape" && editing && (value || onCancel)) {
              e.stopPropagation();
              cancel();
            }
          }}
          onBlur={(e) => {
            // Leaving the field without a change restores the saved key (or drops an empty new field).
            const unchanged = !draft.trim() || draft.trim() === value;
            if (unchanged && e.relatedTarget?.getAttribute("data-key-action") !== actionId && (value || onCancel)) cancel();
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
              {isUrl ? "edit" : "replace"}
            </button>
          )}
          {onMoveUp && !editing && (
            <IconButton label={`Use before the ${isUrl ? "instance" : "key"} above`} tooltipSide="left" className="key-icon-btn" onClick={onMoveUp}>
              <ArrowUp size={14} />
            </IconButton>
          )}
          {onRemove && !editing && (
            <IconButton label={`Remove ${noun}`} tooltipSide="left" className="key-icon-btn key-remove" onClick={onRemove}>
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>
      {line && <div className={cx("key-status", (invalid || status?.status === "invalid") && "key-status-bad")}>{line}</div>}
    </div>
  );
}

interface KeyListProps extends Pick<KeyFieldProps, "scope" | "label" | "kind" | "validate" | "verifies"> {
  /** Saved entries: key ids (the secrets live on the server), or instance URLs. */
  keys: string[];
  /** Receives the new ordered list: saved entries as `{ id }`, a newly typed or replaced key as `{ secret }`. */
  setKeys: (keys: KeyEdit[]) => void;
  autoFocus?: boolean;
  statusOf?: (key: string) => KeyStatus | undefined;
  onRetry?: (key: string) => void;
}

/** An ordered list of keys (primary first, then fallbacks) with "add more". */
function KeyList({ keys, setKeys, autoFocus, statusOf, onRetry, ...field }: KeyListProps) {
  const [adding, setAdding] = useState(false);
  const total = keys.length + (adding ? 1 : 0);
  const saved: KeyEdit[] = keys.map((id) => ({ id }));
  return (
    <div className="key-row">
      <div className="key-label">{field.label}</div>
      <div className="key-fields">
        {keys.map((k, i) => (
          <KeyField
            key={keyId(k)}
            {...field}
            value={k}
            index={i}
            total={total}
            status={statusOf?.(k)}
            onRetry={onRetry && (() => onRetry(k))}
            onSave={(next) => setKeys(saved.map((x, j) => (j === i ? { secret: next } : x)))}
            onRemove={() => setKeys(saved.filter((_, j) => j !== i))}
            onMoveUp={i > 0 ? () => setKeys(saved.map((x, j) => (j === i - 1 ? saved[i]! : j === i ? saved[i - 1]! : x))) : undefined}
          />
        ))}
        {(adding || !keys.length) && (
          <KeyField
            key={`new-${keys.length}`}
            {...field}
            index={keys.length}
            total={total || 1}
            autoFocus={adding || autoFocus}
            onSave={(next) => {
              setKeys([...saved, { secret: next }]);
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

function PlanKeys({ plan, autoFocus }: { plan: PlanId; autoFocus: boolean }) {
  const keys = useStore((s) => s.settings.keys[plan]) ?? [];
  const statuses = useStore((s) => s.detection[plan]?.keys);
  const setKeys = useStore((s) => s.setKeys);
  const refreshDetection = useStore((s) => s.refreshDetection);
  return (
    <KeyList
      scope={plan}
      label={PLANS[plan].label}
      keys={keys}
      setKeys={(next) => void setKeys(plan, next)}
      autoFocus={autoFocus}
      statusOf={(k) => statuses?.[keyId(k)]}
      onRetry={() => refreshDetection(plan)}
    />
  );
}

function VaultNotice() {
  const backend = useStore((s) => s.keyBackend);
  const error = useStore((s) => s.keysError);
  return (
    <>
      {error && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {error}
        </p>
      )}
      {backend === "browser" && (
        <p className="field-help key-status">
          Keys are stored only in this browser. Each request sends the key it needs to the OpenChat relay, which uses it for that request and
          never stores or logs it.
        </p>
      )}
      {backend === "file" && (
        <p className="field-help key-status">
          <CircleAlert size={13} className="bad" /> No OS keychain was found, so keys are stored in a private file (<code>~/.config/openchat/secrets.json</code>, readable only by you).
        </p>
      )}
    </>
  );
}

function KeysSection() {
  const keys = useStore((s) => s.settings.keys);
  const firstEmpty = Object.keys(keys).length === 0;
  return (
    <>
      <Heading>API Keys</Heading>
      <VaultNotice />
      <div className="key-list">
        {KEY_ORDER.map((plan, i) => (
          <PlanKeys key={plan} plan={plan} autoFocus={firstEmpty && i === 0} />
        ))}
      </div>
      <p className="field-help keys-help">
        Add more than one key per plan and OpenChat falls back to the next one if a key is rejected, out of credit, or rate limited. Keys are saved in your
        operating system's keychain by the local OpenChat server and are never sent back to the browser. Get one at{" "}
        <a href="https://opencode.ai/auth" target="_blank" rel="noopener noreferrer">
          opencode.ai
        </a>
        .
      </p>
    </>
  );
}

// ------------------------------------------------------------------ Web Search

function validateInstanceUrl(raw: string) {
  const error = "Enter an address like http://192.168.1.10:8080";
  if (/\s/.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return error;
  try {
    // Browsers percent-encode invalid host characters instead of rejecting them.
    const { hostname } = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return hostname && !hostname.includes("%") ? undefined : error;
  } catch {
    return error;
  }
}

function SearchKeys({ provider }: { provider: SearchProviderId }) {
  const keys = useStore((s) => s.settings.search[provider]) ?? [];
  const statuses = useStore((s) => s.searchStatus[provider]);
  const setSearchKeys = useStore((s) => s.setSearchKeys);
  const verifySearch = useStore((s) => s.verifySearch);
  const config = SEARCH_PROVIDERS[provider];
  // Check entries saved before checks existed (or interrupted by a reload); results are kept.
  useEffect(() => {
    void verifySearch(provider);
  }, [provider, verifySearch]);
  return (
    <KeyList
      scope={`search-${provider}`}
      label={config.label}
      kind={config.credential}
      keys={keys}
      setKeys={(next) => void setSearchKeys(provider, next)}
      validate={config.credential === "url" ? validateInstanceUrl : undefined}
      verifies="search"
      statusOf={(k) => statuses?.[keyId(k)]}
      onRetry={(k) => void verifySearch(provider, [k])}
    />
  );
}

function SearchSection() {
  const enabled = useStore((s) => s.settings.webSearch);
  const configured = useStore((s) => SEARCH_ORDER.filter((p) => s.settings.search[p]?.length).length);
  const update = useStore((s) => s.updateSettings);
  return (
    <>
      <Heading>Web Search</Heading>
      <VaultNotice />
      <div className="setting-row setting-row-top">
        <div className="setting-text">
          <div className="setting-label">Let models search the web</div>
          <p className="setting-desc">
            Each provider you add becomes its own search tool. With two or more, the model picks the one that fits: SearXNG for quick, broad lookups,
            Exa for the latest information, Tavily and Firecrawl for deep research and full pages, Kagi for high-quality technical results, X for
            what people are saying on X.
          </p>
        </div>
        <Toggle checked={enabled} onChange={(v) => update({ webSearch: v })} label="Let models search the web" />
      </div>
      <div className="key-list">
        {SEARCH_ORDER.map((p) => (
          <SearchKeys key={p} provider={p} />
        ))}
      </div>
      <p className="field-help keys-help">
        {configured === 0 ? "Add a key for any provider to turn on web search. " : ""}
        Add more than one key per provider and OpenChat falls back to the next one if a key is rejected, out of credit, or rate limited. For
        SearXNG, enter the address of an instance you already run (over LAN, Tailscale or the internet) with the JSON format enabled; OpenChat
        doesn't start or install anything. Keys are saved in your operating system's keychain by the local OpenChat server and are never sent back to the browser.
      </p>
    </>
  );
}

// ------------------------------------------------------------------ Appearance

function AppearanceSection() {
  const theme = useStore((s) => s.settings.theme);
  const font = useStore((s) => s.settings.font) ?? "normal";
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
      <div className="setting-row">
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
          {section === "account" && (
            <>
              <Heading>Account</Heading>
              <AccountSection />
            </>
          )}
          {section === "general" && <GeneralSection />}
          {section === "keys" && <KeysSection />}
          {section === "search" && <SearchSection />}
          {section === "appearance" && <AppearanceSection />}
        </div>
        <IconButton label="Close settings" tooltip={false} className="modal-close" onClick={close}>
          <X size={18} />
        </IconButton>
      </div>
    </div>
  );
}
