// Settings → Pi (install, version, updates, problems, extensions, skills, prompt templates and
// packages), Settings → Providers (sign in through Pi), and Settings → Projects.
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderUp,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project } from "../../shared/types";
import {
  addProject,
  answerLogin,
  browseFolders,
  cancelLogin,
  clearPiProblems,
  createResource,
  discoverProjects,
  followJob,
  followLogin,
  installPackage,
  installPi,
  logoutProvider,
  readResourceFile,
  removePackage,
  removeProject,
  removeResource,
  renameProject,
  startLogin,
  toggleResource,
  updatePi,
  writeResourceFile,
  type AuthEvent,
  type AuthPrompt,
  type PiProblem,
  type PiProvider,
  type PiResource,
  type ResourceKind,
} from "../lib/pi";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { IconButton, SettingsHeading as Heading, Spinner, Toggle } from "./primitives";

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");

function SubHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="pi-subhead">
      <h3>{children}</h3>
      {action}
    </div>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="pi-error" role="alert">
      <CircleAlert size={14} /> {children}
    </p>
  );
}

// ------------------------------------------------------------------ jobs (install, update, packages)

/** Output of the running (or last) maintenance job, followed live. */
function useJob(onDone: () => void) {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ code?: number; title?: string }>();
  const done = useRef(onDone);
  done.current = onDone;
  const follow = useCallback(async () => {
    setLines([]);
    setResult(undefined);
    try {
      const r = await followJob(
        (line) => setLines((l) => [...l.slice(-400), line]),
        undefined,
        () => setRunning(true),
      );
      setResult(r);
    } finally {
      setRunning(false);
      done.current();
    }
  }, []);
  return { lines, running, result, follow };
}

function JobLog({ job }: { job: ReturnType<typeof useJob> }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [job.lines.length]);
  if (!job.running && !job.result && !job.lines.length) return null;
  return (
    <div className="pi-job">
      <div className="pi-job-head">
        {job.running ? <Spinner size={12} /> : job.result?.code === 0 ? <Check size={14} className="ok" /> : <CircleAlert size={14} className="bad" />}
        <span>{job.running ? "Working…" : job.result?.code === 0 ? `${job.result.title ?? "Done"}: done` : `${job.result?.title ?? "It"} failed (exit code ${job.result?.code ?? "?"})`}</span>
      </div>
      {job.lines.length > 0 && <pre ref={ref} className="pi-job-log">{job.lines.join("\n")}</pre>}
    </div>
  );
}

// ------------------------------------------------------------------ file editor

function FileEditor({ resource, onClose }: { resource: PiResource; onClose: () => void }) {
  const [file, setFile] = useState(resource.files[0]!);
  const [content, setContent] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dirty = content !== undefined && content !== saved;
  useEffect(() => {
    let live = true;
    setContent(undefined);
    setError(undefined);
    readResourceFile(file).then(
      (c) => {
        if (!live) return;
        setContent(c);
        setSaved(c);
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [file]);
  const save = async () => {
    if (content === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await writeResourceFile(file, content);
      setSaved(content);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const leave = () => {
    if (dirty && !confirm("Discard your unsaved changes?")) return;
    onClose();
  };
  return (
    <div className="pi-editor">
      <div className="pi-editor-head">
        <IconButton label="Back" tooltipSide="right" onClick={leave}>
          <ArrowLeft size={17} />
        </IconButton>
        <span className="pi-editor-title">{resource.name}</span>
        {dirty && <span className="badge">unsaved</span>}
        <button type="button" className="btn btn-sm" disabled={!dirty || saving} onClick={save}>
          {saving ? <Spinner size={12} /> : <Save size={14} />} Save
        </button>
      </div>
      {resource.files.length > 1 && (
        <select className="input input-sm pi-editor-files" value={file} aria-label="File" onChange={(e) => (!dirty || confirm("Discard your unsaved changes?")) && setFile(e.target.value)}>
          {resource.files.map((f) => (
            <option key={f} value={f}>
              {f.split("/").slice(2).join("/") || f}
            </option>
          ))}
        </select>
      )}
      <p className="field-help pi-editor-path">{tilde(file.startsWith("~") ? file : `~/.pi/agent/${file}`)} · Pi reloads it for the next message.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {content === undefined ? (
        !error && <Spinner />
      ) : (
        <textarea
          className="pi-code"
          value={content}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              void save();
            } else if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              setContent(el.value.slice(0, a) + "  " + el.value.slice(b));
              requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
            }
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Pi section

const KIND_LABEL: Record<ResourceKind, { title: string; one: string; help: string }> = {
  extension: { title: "Extensions", one: "extension", help: "Tools, commands and providers Pi loads from ~/.pi/agent/extensions." },
  skill: { title: "Skills", one: "skill", help: "Instructions Pi's models can pull in when a task calls for them." },
  prompt: { title: "Prompt templates", one: "prompt template", help: "Saved prompts, run as /name in the composer." },
};

function ResourceList({ kind, items, onChanged, onEdit, busy }: { kind: ResourceKind; items: PiResource[]; onChanged: () => void; onEdit: (r: PiResource) => void; busy: boolean }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const label = KIND_LABEL[kind];
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
    onChanged();
  };
  return (
    <section className="pi-block">
      <SubHeading
        action={
          <button type="button" className="link-btn" onClick={() => setAdding((a) => !a)}>
            <Plus size={13} /> New {label.one}
          </button>
        }
      >
        {label.title}
      </SubHeading>
      <p className="setting-desc">{label.help}</p>
      {adding && (
        <form
          className="pi-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await createResource(kind, name);
              setName("");
              setAdding(false);
            });
          }}
        >
          <input className="input input-sm" autoFocus placeholder={`${label.one} name, e.g. my-${kind}`} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
            Create
          </button>
        </form>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <ul className="pi-list">
        {items.map((r) => (
          <li key={r.id} className={cx("pi-row", !r.enabled && "pi-row-off")}>
            <div className="pi-row-text">
              <span className="pi-row-name">
                {r.name}
                {r.builtin && <span className="badge">built-in</span>}
              </span>
              {r.description && <span className="pi-row-desc">{r.description}</span>}
            </div>
            <span className="pi-row-actions">
              {!r.builtin && r.files.length > 0 && (
                <IconButton label={`Edit ${r.name}`} tooltip="Edit" tooltipSide="top" className="key-icon-btn" onClick={() => onEdit(r)}>
                  <Pencil size={14} />
                </IconButton>
              )}
              {!r.builtin && (
                <IconButton
                  label={`Remove ${r.name}`}
                  tooltip="Remove"
                  tooltipSide="top"
                  className="key-icon-btn key-remove"
                  disabled={busy}
                  onClick={() => confirm(`Remove ${r.name}? It's moved to ~/.pi/agent/.openbuild-trash, so you can bring it back.`) && void act(() => removeResource(r.id))}
                >
                  <Trash2 size={14} />
                </IconButton>
              )}
              <Toggle checked={r.enabled} label={`${r.enabled ? "Turn off" : "Turn on"} ${r.name}`} onChange={(v) => void act(() => toggleResource(r.kind, r.id, v))} />
            </span>
          </li>
        ))}
        {!items.length && <li className="pi-empty">None yet.</li>}
      </ul>
    </section>
  );
}

function Packages({ packages, job, onChanged }: { packages: string[]; job: ReturnType<typeof useJob>; onChanged: () => void }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await job.follow();
    } catch (err) {
      setError((err as Error).message);
    }
    onChanged();
  };
  return (
    <section className="pi-block">
      <SubHeading>Packages</SubHeading>
      <p className="setting-desc">Extensions, skills and prompts bundled as npm or git packages (pi install).</p>
      <ul className="pi-list">
        {packages.map((p) => (
          <li key={p} className="pi-row">
            <div className="pi-row-text">
              <span className="pi-row-name pi-mono">{p}</span>
            </div>
            <IconButton label={`Remove ${p}`} tooltip="Remove" tooltipSide="top" className="key-icon-btn key-remove" disabled={job.running} onClick={() => confirm(`Remove ${p}?`) && void run(() => removePackage(p))}>
              <Trash2 size={14} />
            </IconButton>
          </li>
        ))}
        {!packages.length && <li className="pi-empty">No packages installed.</li>}
      </ul>
      <form
        className="pi-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (source.trim()) void run(() => installPackage(source.trim())).then(() => setSource(""));
        }}
      >
        <input className="input input-sm" placeholder="npm:@scope/pkg or git:github.com/you/repo" value={source} spellCheck={false} autoCapitalize="off" onChange={(e) => setSource(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!source.trim() || job.running}>
          Install
        </button>
      </form>
      {error && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function Problems({ problems, onClear }: { problems: PiProblem[]; onClear: () => void }) {
  const [open, setOpen] = useState<number>();
  return (
    <section className="pi-block">
      <SubHeading
        action={
          problems.length > 0 && (
            <button type="button" className="link-btn" onClick={onClear}>
              Clear
            </button>
          )
        }
      >
        Problems {problems.length > 0 && <span className="badge badge-bad">{problems.length}</span>}
      </SubHeading>
      {problems.length ? (
        <ul className="pi-list">
          {[...problems].reverse().map((p, i) => (
            <li key={`${p.at}-${i}`} className="pi-row pi-problem">
              <button type="button" className="pi-problem-head" aria-expanded={open === i} onClick={() => setOpen(open === i ? undefined : i)}>
                <CircleAlert size={14} className="bad" />
                <span className="pi-row-text">
                  <span className="pi-row-name">{p.source === "pi" ? "Pi" : tilde(p.source).split("/").slice(-2).join("/")}</span>
                  <span className={cx("pi-row-desc", open !== i && "pi-clamp")}>{p.message}</span>
                </span>
                <span className="pi-time">{new Date(p.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pi-empty">Nothing reported. Warnings and extension errors from Pi show up here.</p>
      )}
    </section>
  );
}

export function PiSection() {
  // Everything here comes from the cache filled at launch, so the page opens with its content.
  const status = useStore((s) => s.piCache.status);
  const data = useStore((s) => s.piCache.resources);
  const problems = useStore((s) => s.piCache.problems) ?? [];
  const loadPiStatus = useStore((s) => s.loadPiStatus);
  const loadPiResources = useStore((s) => s.loadPiResources);
  const [statusError, setStatusError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState<PiResource>();
  const refreshDetection = useStore((s) => s.refreshDetection);

  const loadStatus = useCallback(
    async (fresh = false, quiet = false) => {
      if (!quiet) setChecking(true);
      try {
        await loadPiStatus(fresh);
        setStatusError(undefined);
      } catch (err) {
        setStatusError((err as Error).message);
      } finally {
        if (!quiet) setChecking(false);
      }
    },
    [loadPiStatus],
  );
  const loadResources = useCallback(async () => {
    await loadPiResources().catch(() => {});
  }, [loadPiResources]);
  const job = useJob(() => {
    void loadStatus(true);
    void loadResources();
    void refreshDetection();
  });

  useEffect(() => {
    // Revalidate quietly; the cached status and resources are already on screen.
    void loadStatus(false, true);
    void loadResources();
    // Pick up a job that was already running (e.g. an update started before a reload).
    void job.follow();
  }, []);

  if (editing) return <FileEditor resource={editing} onClose={() => (setEditing(undefined), void loadResources())} />;

  const start = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await job.follow();
    } catch (err) {
      setStatusError((err as Error).message);
    }
  };
  const by = (k: ResourceKind) => data?.resources.filter((r) => r.kind === k) ?? [];

  return (
    <>
      <Heading>Pi</Heading>
      <p className="setting-desc pi-intro">
        OpenBuild runs every thread on the Pi installed on this computer: its models, credentials, extensions and skills are the same ones the <code>pi</code> command uses.
      </p>
      <section className="pi-card">
        {!status ? (
          statusError ? <ErrorNote>{statusError}</ErrorNote> : <Spinner />
        ) : status.installed ? (
          <>
            <div className="pi-card-row">
              <div className="pi-card-text">
                <div className="pi-version">
                  Pi {status.version}
                  {status.updateAvailable ? <span className="badge badge-accent">{status.latest} available</span> : status.latest && <span className="badge">up to date</span>}
                </div>
                <div className="pi-meta">
                  {tilde(status.bin ?? "")} · {status.kind === "managed" ? "installed with Pi's installer" : status.kind === "npm" ? "installed with npm" : "custom install"}
                </div>
              </div>
              {status.updateAvailable ? (
                <button type="button" className="btn btn-sm btn-primary" disabled={job.running} onClick={() => void start(() => updatePi())}>
                  Update to {status.latest}
                </button>
              ) : (
                <button type="button" className="btn btn-sm" disabled={checking || job.running} onClick={() => void loadStatus(true)}>
                  {checking ? <Spinner size={12} /> : <RefreshCw size={14} />} Check for updates
                </button>
              )}
            </div>
            {status.checkError && <p className="pi-meta">{status.checkError}</p>}
            <div className="pi-card-links">
              <button type="button" className="link-btn" disabled={job.running} onClick={() => void start(() => updatePi(true))}>
                Update Pi and all packages
              </button>
              <span className="pi-meta">Config: {tilde(status.agentDir)}</span>
            </div>
          </>
        ) : (
          <div className="pi-card-row">
            <div className="pi-card-text">
              <div className="pi-version">Pi isn't installed</div>
              <div className="pi-meta">
                OpenBuild needs Pi to run threads. Install it with Pi's installer (<code>curl -fsSL https://pi.dev/install.sh | sh</code>) here or in a terminal.
              </div>
            </div>
            <button type="button" className="btn btn-sm btn-primary" disabled={job.running} onClick={() => void start(installPi)}>
              Install Pi
            </button>
          </div>
        )}
        {statusError && status && <ErrorNote>{statusError}</ErrorNote>}
        <JobLog job={job} />
      </section>

      {status?.installed && (
        <>
          <Problems
            problems={problems}
            onClear={() =>
              void clearPiProblems().then(() => useStore.setState((s) => ({ piCache: { ...s.piCache, problems: [] } })))
            }
          />
          {!data ? (
            <Spinner />
          ) : (
            <>
              <ResourceList kind="extension" items={by("extension")} onChanged={loadResources} onEdit={setEditing} busy={job.running} />
              <ResourceList kind="skill" items={by("skill")} onChanged={loadResources} onEdit={setEditing} busy={job.running} />
              <ResourceList kind="prompt" items={by("prompt")} onChanged={loadResources} onEdit={setEditing} busy={job.running} />
              <Packages packages={data.packages} job={job} onChanged={loadResources} />
            </>
          )}
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Providers

const SOURCE_LABEL: Record<string, string> = {
  stored: "Saved in Pi",
  runtime: "Set for this session only",
  environment: "Key from an environment variable",
  fallback: "Using Pi's default credentials",
  models_json_key: "Key from models.json",
  models_json_command: "Command from models.json",
};

/** A sign-in in progress: what Pi shows and asks, answered right here. */
function LoginFlow({ provider, type, onEnd }: { provider: PiProvider; type: "api_key" | "oauth"; onEnd: (ok: boolean) => void }) {
  const [id, setId] = useState<string>();
  const [events, setEvents] = useState<AuthEvent[]>([]);
  const [prompt, setPrompt] = useState<{ id: string; prompt: AuthPrompt }>();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const end = useRef(onEnd);
  end.current = onEnd;

  useEffect(() => {
    const ctrl = new AbortController();
    let loginId: string | undefined;
    void (async () => {
      try {
        loginId = await startLogin(provider.id, type);
        setId(loginId);
        for await (const r of followLogin(loginId, ctrl.signal)) {
          if (r.type === "event") setEvents((e) => [...e, r.event]);
          else if (r.type === "prompt") {
            setPrompt({ id: r.id, prompt: r.prompt });
            setValue("");
          } else if (r.type === "prompt_closed") setPrompt((p) => (p?.id === r.id ? undefined : p));
          else if (r.type === "error") setError(r.message);
          else if (r.type === "done") {
            setDone(true);
            setTimeout(() => end.current(true), 900);
          }
        }
      } catch (err) {
        if (!ctrl.signal.aborted) setError((err as Error).message);
      }
    })();
    return () => {
      ctrl.abort();
      if (loginId) void cancelLogin(loginId).catch(() => {});
    };
  }, [provider.id, type]);

  const reply = (v: string) => {
    if (!id || !prompt) return;
    void answerLogin(id, prompt.id, v).catch((err: Error) => setError(err.message));
    setPrompt(undefined);
  };
  const url = [...events].reverse().find((e): e is Extract<AuthEvent, { type: "auth_url" }> => e.type === "auth_url");
  const device = [...events].reverse().find((e): e is Extract<AuthEvent, { type: "device_code" }> => e.type === "device_code");
  const notes = events.filter((e): e is Extract<AuthEvent, { type: "info" | "progress" }> => e.type === "info" || e.type === "progress");
  const remote = !["localhost", "127.0.0.1"].includes(location.hostname);

  return (
    <div className="login">
      <div className="login-head">
        <span>{type === "oauth" ? (provider.oauth?.label ?? `Sign in to ${provider.name}`) : `${provider.name} API key`}</span>
        <IconButton label="Cancel sign-in" tooltipSide="left" onClick={() => end.current(false)}>
          <X size={15} />
        </IconButton>
      </div>
      {done ? (
        <p className="login-done">
          <Check size={15} className="ok" /> Signed in. {provider.name}'s models are now available.
        </p>
      ) : (
        <>
          {!id && !error && <Spinner />}
          {url && (
            <div className="login-step">
              <a className="btn btn-sm btn-primary" href={url.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} /> Open the sign-in page
              </a>
              {url.instructions && <p className="setting-desc">{url.instructions}</p>}
              {remote && <p className="setting-desc">If the page ends on an address that won't load (starting with http://localhost or 127.0.0.1), copy that whole address and paste it below.</p>}
            </div>
          )}
          {device && (
            <div className="login-step">
              <p className="setting-desc">Enter this code at the sign-in page:</p>
              <code className="login-code">{device.userCode}</code>
              <a className="btn btn-sm" href={device.verificationUri} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} /> {device.verificationUri.replace(/^https?:\/\//, "")}
              </a>
            </div>
          )}
          {notes.slice(-3).map((n, i) => (
            <p key={i} className="setting-desc">
              {n.message}
              {n.type === "info" &&
                n.links?.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="login-link">
                    {l.label ?? l.url}
                  </a>
                ))}
            </p>
          ))}
          {prompt &&
            (prompt.prompt.type === "select" ? (
              <div className="login-step">
                <p className="setting-desc">{prompt.prompt.message}</p>
                <div className="login-options">
                  {prompt.prompt.options.map((o) => (
                    <button key={o.id} type="button" className="btn btn-sm" title={o.description} onClick={() => reply(o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <form
                className="login-step"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (value.trim()) reply(value.trim());
                }}
              >
                <label className="setting-desc" htmlFor="login-input">
                  {prompt.prompt.message}
                </label>
                <div className="pi-inline-form">
                  <input
                    id="login-input"
                    className="input input-sm"
                    type={prompt.prompt.type === "secret" ? "password" : "text"}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    autoFocus
                    placeholder={prompt.prompt.placeholder}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                  <button type="submit" className="btn btn-sm" disabled={!value.trim()}>
                    {prompt.prompt.type === "secret" ? "Save" : "Continue"}
                  </button>
                </div>
              </form>
            ))}
          {!prompt && id && !error && !url && !device && <Spinner />}
          {error && <ErrorNote>{error}</ErrorNote>}
        </>
      )}
    </div>
  );
}

export function ProvidersSection() {
  const providers = useStore((s) => s.piCache.providers);
  const loadPiProviders = useStore((s) => s.loadPiProviders);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [login, setLogin] = useState<{ provider: PiProvider; type: "api_key" | "oauth" }>();
  const [busy, setBusy] = useState<string>();
  const refreshDetection = useStore((s) => s.refreshDetection);
  const models = useStore((s) => s.detection.pi?.models);

  const load = useCallback(async () => {
    try {
      await loadPiProviders();
      setError(undefined);
    } catch (err) {
      // A cached list beats an error page; keep showing what Pi last told us.
      if (!useStore.getState().piCache.providers) setError((err as Error).message);
    }
  }, [loadPiProviders]);
  useEffect(() => {
    void load();
  }, [load]);

  const usable = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of models ?? []) if (m.provider) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
    return counts;
  }, [models]);

  const q = query.trim().toLowerCase();
  const match = (p: PiProvider) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q);
  const configured = (providers ?? []).filter((p) => p.status.configured && match(p));
  const others = (providers ?? []).filter((p) => !p.status.configured && match(p) && (p.oauth || p.apiKey?.canLogin));

  const signOut = async (p: PiProvider) => {
    if (!confirm(`Sign out of ${p.name}? Pi forgets the saved ${p.stored === "oauth" ? "sign-in" : "API key"}.`)) return;
    setBusy(p.id);
    try {
      await logoutProvider(p.id);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(undefined);
    await load();
    void refreshDetection();
  };

  /** What Pi has for a provider, in words that don't depend on how the row is laid out. */
  const credential = (p: PiProvider) => {
    if (p.stored === "oauth") return "Signed in";
    if (p.stored === "api_key") return "API key saved";
    return SOURCE_LABEL[p.status.source ?? ""] ?? "Configured";
  };

  /** One button per way in: refresh the saved one first, then the other one if there is one. */
  const actions = (p: PiProvider) => {
    const signedIn = p.status.configured && p.stored === "oauth";
    const keyed = p.status.configured && p.stored === "api_key";
    return (
      <span className="pi-row-actions">
        {p.oauth && (
          <button type="button" className="btn btn-sm" onClick={() => setLogin({ provider: p, type: "oauth" })}>
            {signedIn ? "Sign in again" : keyed ? "Sign in instead" : "Sign in"}
          </button>
        )}
        {p.apiKey?.canLogin && (
          <button type="button" className="btn btn-sm" onClick={() => setLogin({ provider: p, type: "api_key" })}>
            {keyed ? "Replace API key" : signedIn ? "Use API key" : "Add API key"}
          </button>
        )}
        {p.stored && (
          <IconButton label={`Sign out of ${p.name}`} tooltip="Sign out" tooltipSide="top" className="key-icon-btn key-remove" disabled={busy === p.id} onClick={() => void signOut(p)}>
            {busy === p.id ? <Spinner size={12} /> : <Trash2 size={14} />}
          </IconButton>
        )}
      </span>
    );
  };

  const modelsLine = (count: number) => (count ? `${count} model${count === 1 ? "" : "s"} available` : "No models available");

  return (
    <>
      <Heading>Providers</Heading>
      <p className="setting-desc pi-intro">
        Set up the model providers Pi uses, either by signing in with a subscription or by saving an API key. Credentials are saved by Pi in <code>~/.pi/agent/auth.json</code>, the
        same as <code>/login</code> in Pi, so the <code>pi</code> command uses them too. Custom endpoints go in <code>~/.pi/agent/models.json</code>.
      </p>
      {login && (
        <LoginFlow
          key={`${login.provider.id}:${login.type}`}
          provider={login.provider}
          type={login.type}
          onEnd={(ok) => {
            setLogin(undefined);
            if (ok) {
              void load();
              void refreshDetection();
            }
          }}
        />
      )}
      <label className="search pi-search">
        <Search size={15} />
        <input type="text" placeholder="Search providers…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!providers ? (
        !error && <Spinner />
      ) : (
        <>
          <section className="pi-block">
            <SubHeading>Ready to use</SubHeading>
            <ul className="pi-list">
              {configured.map((p) => (
                <li key={p.id} className="pi-row">
                  <div className="pi-row-text">
                    <span className="pi-row-name">
                      {p.name}
                      <Check size={13} className="ok" />
                    </span>
                    <span className="pi-row-desc">
                      {credential(p)} · {modelsLine(usable.get(p.id) ?? 0)}
                    </span>
                  </div>
                  {actions(p)}
                </li>
              ))}
              {!configured.length && <li className="pi-empty">{q ? "No match." : "No provider is set up yet. Add one below."}</li>}
            </ul>
          </section>
          <section className="pi-block">
            <SubHeading>Add a provider</SubHeading>
            <ul className="pi-list">
              {others.map((p) => (
                <li key={p.id} className="pi-row">
                  <div className="pi-row-text">
                    <span className="pi-row-name">{p.name}</span>
                    <span className="pi-row-desc">
                      {[p.oauth?.subscription ? p.oauth.name : p.oauth ? "Sign in" : "", p.apiKey?.canLogin ? (p.apiKey.name || "API key") : ""].filter(Boolean).join(" or ")}
                      {p.models ? ` · ${p.models} model${p.models === 1 ? "" : "s"}` : ""}
                    </span>
                  </div>
                  {actions(p)}
                </li>
              ))}
              {!others.length && <li className="pi-empty">{q ? "No match." : "Every provider Pi knows is already set up."}</li>}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Projects

function FolderBrowser({ onAdd }: { onAdd: (path: string) => Promise<void> }) {
  const [dir, setDir] = useState<string>();
  const [data, setData] = useState<Awaited<ReturnType<typeof browseFolders>>>();
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState("");
  useEffect(() => {
    let live = true;
    browseFolders(dir).then(
      (d) => {
        if (!live) return;
        setData(d);
        setTyped(tilde(d.dir));
        setError(undefined);
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [dir]);
  return (
    <div className="browser">
      <form
        className="pi-inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setDir(typed.trim());
        }}
      >
        <IconButton label="Up a folder" tooltipSide="top" disabled={!data?.parent} onClick={() => data?.parent && setDir(data.parent)}>
          <FolderUp size={16} />
        </IconButton>
        <input className="input input-sm pi-mono" value={typed} spellCheck={false} autoCapitalize="off" aria-label="Folder" onChange={(e) => setTyped(e.target.value)} />
        <button type="button" className="btn btn-sm btn-primary" disabled={!data} onClick={() => data && void onAdd(data.dir)}>
          Add this folder
        </button>
      </form>
      {error && <ErrorNote>{error}</ErrorNote>}
      <ul className="browser-list">
        {data?.entries.map((e) => (
          <li key={e.path} className="browser-row">
            <button type="button" className="browser-open" onClick={() => setDir(e.path)}>
              {e.git ? <FolderGit2 size={15} className="ok" /> : <Folder size={15} />}
              <span>{e.name}</span>
              <ChevronRight size={14} className="browser-chevron" />
            </button>
            {e.git && (
              <button type="button" className="btn btn-sm" onClick={() => void onAdd(e.path)}>
                Add
              </button>
            )}
          </li>
        ))}
        {data && !data.entries.length && <li className="pi-empty">No folders here.</li>}
      </ul>
    </div>
  );
}

function ProjectRow({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  return (
    <li className={cx("pi-row", project.missing && "pi-row-off")}>
      {project.git ? <FolderGit2 size={16} className="pi-row-icon" /> : <Folder size={16} className="pi-row-icon" />}
      <div className="pi-row-text">
        {renaming ? (
          <form
            className="pi-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void renameProject(project.id, name).then(onChanged);
              setRenaming(false);
            }}
          >
            <input className="input input-sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(false)} />
          </form>
        ) : (
          <span className="pi-row-name">{project.name}</span>
        )}
        <span className="pi-row-desc pi-mono">{project.missing ? `Missing: ${tilde(project.path)}` : tilde(project.path)}</span>
      </div>
      <span className="pi-row-actions">
        <IconButton label={`Rename ${project.name}`} tooltip="Rename" tooltipSide="top" className="key-icon-btn" onClick={() => setRenaming(true)}>
          <Pencil size={14} />
        </IconButton>
        <IconButton
          label={`Remove ${project.name}`}
          tooltip="Remove from OpenBuild"
          tooltipSide="top"
          className="key-icon-btn key-remove"
          onClick={() => confirm(`Remove ${project.name} from OpenBuild? The folder and its threads stay as they are.`) && void removeProject(project.id).then(onChanged)}
        >
          <Trash2 size={14} />
        </IconButton>
      </span>
    </li>
  );
}

export function ProjectsSection() {
  const projects = useStore((s) => s.projects);
  const loadProjects = useStore((s) => s.loadProjects);
  const updateSettings = useStore((s) => s.updateSettings);
  const pref = useStore((s) => s.settings.workspace);
  const [found, setFound] = useState<{ name: string; path: string }[]>();
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<string>();

  useEffect(() => {
    void loadProjects();
    discoverProjects().then(setFound, () => setFound([]));
  }, [loadProjects]);

  const add = async (path: string) => {
    setError(undefined);
    try {
      const p = await addProject(path);
      await loadProjects();
      setFound((f) => f?.filter((x) => x.path !== p.path));
      setAdded(p.name);
      setBrowsing(false);
      // The first project becomes where new threads work.
      if (!pref.projectId) updateSettings({ workspace: { ...pref, projectId: p.id } });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <Heading>Projects</Heading>
      <p className="setting-desc pi-intro">
        Folders on this computer that threads can work in. Pick one under the composer when you start a thread, in its own checkout or in a new git worktree (kept in OpenBuild's data folder).
      </p>
      <ul className="pi-list">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} onChanged={loadProjects} />
        ))}
        {!projects.length && <li className="pi-empty">No projects yet. Add a folder below.</li>}
      </ul>
      {added && (
        <p className="setting-desc">
          <Check size={13} className="ok" /> Added {added}.
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <section className="pi-block">
        <SubHeading
          action={
            <button type="button" className="link-btn" onClick={() => setBrowsing((b) => !b)}>
              {browsing ? "Close" : "Browse folders…"}
            </button>
          }
        >
          Add a project
        </SubHeading>
        {browsing && <FolderBrowser onAdd={add} />}
        {found === undefined ? (
          <Spinner />
        ) : found.length ? (
          <>
            <p className="setting-desc">Repositories found in your usual code folders:</p>
            <ul className="pi-list">
              {found.slice(0, 60).map((f) => (
                <li key={f.path} className="pi-row">
                  <FolderGit2 size={16} className="pi-row-icon" />
                  <div className="pi-row-text">
                    <span className="pi-row-name">{f.name}</span>
                    <span className="pi-row-desc pi-mono">{tilde(f.path)}</span>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => void add(f.path)}>
                    Add
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          !browsing && <p className="setting-desc">Browse to a folder to add it.</p>
        )}
      </section>
    </>
  );
}

