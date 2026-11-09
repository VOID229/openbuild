// Settings → Bots → Web search: the user's own keys for each provider, with fallbacks, checked when
// saved. Keys go to the server's vault and never come back; bots search through the server, so they
// don't see them either. SearXNG is an address rather than a key, kept with the bots' settings.
import { ArrowUp, Check, ChevronDown, ChevronUp, CircleAlert, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SEARCH_ORDER, SEARCH_PROVIDERS, type KeyEdit, type SearchProviderId } from "../../../shared/types";
import { verifySearch } from "../../lib/api";
import { useBots } from "../../lib/bots/store";
import { keyId } from "../../lib/keys";
import { useStore } from "../../lib/store";
import type { KeyStatus } from "../../lib/types";
import { cx } from "../../lib/ui";
import { IconButton, Spinner } from "../primitives";

const MASK = "*".repeat(34);

interface KeyFieldProps {
  provider: SearchProviderId;
  /** Saved key id or address; undefined for a new, unsaved field. */
  value?: string;
  index: number;
  total: number;
  autoFocus?: boolean;
  status?: KeyStatus;
  onRetry?: () => void;
  onSave: (key: string) => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  /** New fields only: discard the empty field. */
  onCancel?: () => void;
}

function validateInstanceUrl(raw: string) {
  const error = "Enter an address like http://192.168.1.10:8080";
  if (/\s/.test(raw) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw))) return error;
  try {
    // Browsers percent-encode invalid host characters instead of rejecting them.
    const { hostname } = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return hostname && !hostname.includes("%") ? undefined : error;
  } catch {
    return error;
  }
}

function KeyField({ provider, value, index, total, autoFocus, status, onRetry, onSave, onRemove, onMoveUp, onCancel }: KeyFieldProps) {
  const { label, credential } = SEARCH_PROVIDERS[provider];
  const isUrl = credential === "url";
  const [editing, setEditing] = useState(!value);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const masked = !editing && !isUrl && !!value;
  const noun = isUrl ? "address" : "key";
  const actionId = `${provider}-${index}`;

  useEffect(() => {
    if (autoFocus) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replace = () => {
    setEditing(true);
    // Addresses aren't secret: edit the saved value rather than retyping it.
    setDraft(isUrl ? (value ?? "") : "");
    requestAnimationFrame(() => (isUrl ? input.current?.select() : input.current?.focus()));
  };
  const save = () => {
    const next = draft.trim();
    if (!next) return;
    const error = isUrl ? validateInstanceUrl(next) : undefined;
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

  // Short results sit inline next to the key; errors get their own line below it.
  let badge: ReactNode = null;
  let line: ReactNode = null;
  if (invalid) line = (<><CircleAlert size={13} className="bad" /> {invalid}</>);
  else if (value && status && !editing) {
    if (status.status === "checking") badge = (<><Spinner size={12} /> Checking</>);
    else if (status.status === "valid") badge = (<><Check size={13} className="ok" /> {isUrl ? "Reachable" : "Works"}</>);
    else if (status.status === "invalid") line = (<><CircleAlert size={13} className="bad" /> {status.error ?? `Invalid ${noun}`}: {isUrl ? "edit" : "replace"} it to continue</>);
    else
      line = (
        <>
          <CircleAlert size={13} className="bad" /> {status.error ?? `Couldn't check this ${noun}`}
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
      <div className="key-entry-row">
        <div className={cx("key-input-wrap", total > 1 && "key-input-tagged")}>
          <input
            ref={input}
            id={`key-search-${actionId}`}
            className={cx("input key-input", !editing && "key-input-masked")}
            type={editing && !isUrl ? "password" : "text"}
            inputMode={isUrl ? "url" : undefined}
            readOnly={!editing}
            value={editing ? draft : isUrl ? value : ""}
            placeholder={masked ? undefined : isUrl ? "http://192.168.1.10:8080" : index === 0 ? `Paste your ${label} key` : `Paste another ${label} key`}
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
          {masked && <span className="key-mask" aria-hidden>{MASK}</span>}
          {total > 1 && <span className="key-tag">{index === 0 ? "primary" : "fallback"}</span>}
        </div>
        <div className="key-badge" role="status">
          {badge}
        </div>
        <div className="key-actions">
          {editing ? (
            <button type="button" className="btn btn-sm" data-key-action={actionId} disabled={!draft.trim()} onClick={save}>
              Save
            </button>
          ) : (
            <button type="button" className="btn btn-sm" data-key-action={actionId} onClick={replace}>
              {isUrl ? "Edit" : "Replace"}
            </button>
          )}
          {onRemove && !editing && (
            <IconButton label={`Remove ${noun}`} tooltipSide="left" className="key-icon-btn key-remove" onClick={onRemove}>
              <Trash2 size={14} />
            </IconButton>
          )}
          {onMoveUp && !editing && (
            <IconButton label={`Use before the ${noun} above`} tooltipSide="left" className="key-icon-btn" onClick={onMoveUp}>
              <ArrowUp size={14} />
            </IconButton>
          )}
        </div>
      </div>
      {line && <div className={cx("key-status", (invalid || status?.status === "invalid") && "key-status-bad")}>{line}</div>}
    </div>
  );
}

interface KeyListProps {
  provider: SearchProviderId;
  /** Saved entries: key ids (the secrets live on the server), or instance addresses. */
  keys: string[];
  /** Receives the new ordered list: saved entries as `{ id }`, a newly typed or replaced one as `{ secret }`. */
  setKeys: (keys: KeyEdit[]) => void;
  statusOf: (key: string) => KeyStatus | undefined;
  onRetry: (key: string) => void;
}

/** An ordered list of keys (primary first, then fallbacks) with "add more". Two or more collapse to the primary behind a chevron. */
function KeyList({ provider, keys, setKeys, statusOf, onRetry }: KeyListProps) {
  const { label, site, credential } = SEARCH_PROVIDERS[provider];
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsible = keys.length > 1;
  const open = expanded || !collapsible;
  const shown = open ? keys : keys.slice(0, 1);
  const total = keys.length + (adding ? 1 : 0);
  const saved: KeyEdit[] = keys.map((id) => ({ id }));
  const toggle = () => {
    setAdding(false);
    setExpanded((v) => !v);
  };
  return (
    <div className="key-row">
      <div className="key-label">
        <span>{label}</span>
        {collapsible && (
          <IconButton label={open ? `Hide ${label} fallbacks` : `Show ${keys.length - 1} more for ${label}`} tooltipSide="right" className="key-more" aria-expanded={open} onClick={toggle}>
            {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </IconButton>
        )}
        <a className="key-site" href={site} target="_blank" rel="noopener noreferrer">
          {credential === "url" ? "Set one up" : "Get a key"} <ExternalLink size={11} />
        </a>
      </div>
      <div className="key-fields">
        {shown.map((k, i) => (
          <KeyField
            key={keyId(k)}
            provider={provider}
            value={k}
            index={i}
            total={total}
            status={statusOf(k)}
            onRetry={() => onRetry(k)}
            onSave={(next) => setKeys(saved.map((x, j) => (j === i ? { secret: next } : x)))}
            onRemove={() => setKeys(saved.filter((_, j) => j !== i))}
            onMoveUp={i > 0 ? () => setKeys(saved.map((x, j) => (j === i - 1 ? saved[i]! : j === i ? saved[i - 1]! : x))) : undefined}
          />
        ))}
        {(adding || !keys.length) && (
          <KeyField
            key={`new-${keys.length}`}
            provider={provider}
            index={keys.length}
            total={total || 1}
            autoFocus={adding}
            onSave={(next) => {
              setKeys([...saved, { secret: next }]);
              setAdding(false);
            }}
            onCancel={keys.length ? () => setAdding(false) : undefined}
          />
        )}
        {open && keys.length > 0 && !adding && (
          <button type="button" className="add-key" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add another
          </button>
        )}
      </div>
    </div>
  );
}

function ProviderKeys({ provider }: { provider: SearchProviderId }) {
  const keys = useStore((s) => s.settings.search[provider]) ?? [];
  const statuses = useStore((s) => s.searchStatus[provider]);
  const st = useStore.getState();
  return <KeyList provider={provider} keys={keys} setKeys={(next) => void st.setSearchKeys(provider, next)} statusOf={(k) => statuses?.[keyId(k)]} onRetry={(k) => void st.verifySearch(provider, [k])} />;
}

/** SearXNG's addresses live with the bots' settings on the server, where the bots can reach them. */
function SearxngKeys() {
  const urls = useBots((s) => s.searxng);
  const [statuses, setStatuses] = useState<Record<string, KeyStatus>>({});
  const check = async (url: string) => {
    setStatuses((s) => ({ ...s, [url]: { status: "checking" } }));
    const r = await verifySearch("searxng", url);
    setStatuses((s) => ({ ...s, [url]: { status: r.status, error: r.error } }));
  };
  const setKeys = (edits: KeyEdit[]) => {
    const next = [...new Set(edits.map((e) => ("id" in e ? e.id : e.secret).trim()).filter(Boolean))];
    useBots.getState().setSearxng(next);
    for (const url of next) if (!urls.includes(url)) void check(url);
  };
  return <KeyList provider="searxng" keys={urls} setKeys={setKeys} statusOf={(url) => statuses[url]} onRetry={(url) => void check(url)} />;
}

/** Providers with a key or address saved, named in the order they're tried. */
function useConfiguredProviders() {
  const search = useStore((s) => s.settings.search);
  const searxng = useBots((s) => s.searxng);
  return SEARCH_ORDER.filter((p) => (SEARCH_PROVIDERS[p].credential === "url" ? searxng.length > 0 : (search[p]?.length ?? 0) > 0)).map((p) => SEARCH_PROVIDERS[p].label);
}

export function BotWebSearch() {
  const backend = useStore((s) => s.keyBackend);
  const error = useStore((s) => s.keysError);
  // Collapsed by default: the list is long, and the header already says which providers are set up.
  const [open, setOpen] = useState(false);
  const configured = useConfiguredProviders();
  return (
    <>
      <div className="pi-subhead">
        <button type="button" className="pi-subhead-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="pi-subhead-title">Web search</span>
          <span className="pi-subhead-note">{configured.length ? configured.join(", ") : "No keys yet"}</span>
          <ChevronDown size={15} className="pi-subhead-chevron" />
        </button>
      </div>
      <div className={cx("collapse", open && "collapse-open")} inert={!open}>
        <div className="collapse-inner">
          <p className="setting-desc">Add a key for any provider and every bot can search with it. Searches are billed to your account with that provider.</p>
          {error && (
            <p className="field-help key-status key-status-bad" role="alert">
              <CircleAlert size={13} className="bad" /> {error}
            </p>
          )}
          {backend === "file" && <p className="field-help key-status">This server has no OS keychain, so keys are saved in a private file in its config folder.</p>}
          <div className="key-list">
            {SEARCH_ORDER.map((p) => (SEARCH_PROVIDERS[p].credential === "url" ? <SearxngKeys key={p} /> : <ProviderKeys key={p} provider={p} />))}
          </div>
          <p className="field-help keys-help">With more than one key, the next takes over when one is rejected or rate limited. Keys stay on this server and are never shown to bots. SearXNG needs an instance with JSON output turned on.</p>
        </div>
      </div>
    </>
  );
}
