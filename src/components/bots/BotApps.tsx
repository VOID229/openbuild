// OpenBots' Marketplace: a catalog of official MCP servers and skills to search and browse, a page
// for each app with whatever it takes to connect it, and the card a bot posts to offer one in a chat.
import { ArrowLeft, Check, CircleAlert, Copy, ExternalLink, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { APP_CALLBACK_PATH, APP_CATALOG, APP_CATEGORIES, appById, OAUTH_CLIENTS, type AppCategory, type AppView, type CatalogApp } from "../../../shared/apps";
import { isConnected, pastesSignIn, useApps, type ConnectInput } from "../../lib/bots/apps";
import { useRemoteWorkspace } from "../../lib/bots/store";
import { useGithub } from "../../lib/github";
import { copyText, cx } from "../../lib/ui";
import { IconButton, Spinner } from "../primitives";
import { useModal } from "./BotDialogs";
import { openBotsDialog } from "./BotsSidebar";
import { GithubSignIn } from "./GithubSignIn";

export function AppLogo({ app, size = 40 }: { app: CatalogApp; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className="app-logo" style={{ width: size, height: size }} aria-hidden>
      {broken ? <span className="app-logo-letter">{app.name[0]}</span> : <img src={`/api/bots/apps/${app.id}/logo`} alt="" loading="lazy" onError={() => setBroken(true)} />}
    </span>
  );
}

/** Nothing to type in before it can connect, so a click on Connect can just go. */
const connectsStraightAway = (app: CatalogApp, clients: string[]) => {
  const c = app.connection;
  if (app.fields?.length || c.kind === "token" || c.kind === "local" || c.kind === "desktop") return false;
  // A client the server keeps goes straight to sign-in; if it's missing, Connect says so.
  return c.kind !== "client" || !!OAUTH_CLIENTS[c.client].env || clients.includes(c.client);
};

/** Where a connection stands, beside the app's name: a dot for its state and a word for it. */
function statusOf(view?: AppView): { label: string; tone: "ok" | "warn" | "bad" | "busy" } | undefined {
  if (view?.status === "connected") return { label: "Connected", tone: "ok" };
  if (view?.status === "needs-auth") return { label: "Signed out", tone: "warn" };
  if (view?.status === "error") return { label: "Couldn't connect", tone: "bad" };
  if (view?.status === "connecting") return { label: "Waiting for sign-in", tone: "busy" };
  return undefined;
}

function AppStatus({ view }: { view?: AppView }) {
  const status = statusOf(view);
  if (!status) return null;
  return (
    <span className={cx("app-status", `app-status-${status.tone}`)}>
      <span className="app-status-dot" aria-hidden />
      {status.label}
    </span>
  );
}

function AppRow({ app, onOpen }: { app: CatalogApp; onOpen: () => void }) {
  const view = useApps((s) => s.apps[app.id]);
  const clients = useApps((s) => s.clients);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const go = async () => {
    if (!connectsStraightAway(app, clients)) return onOpen();
    setBusy(true);
    setProblem(undefined);
    try {
      await useApps.getState().connect(app.id);
      if (pastesSignIn(app)) onOpen();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="app-row">
      <button type="button" className="app-row-main" onClick={onOpen}>
        <AppLogo app={app} size={36} />
        <span className="app-row-text">
          <span className="app-row-name">
            {app.name}
            <AppStatus view={view} />
          </span>
          {problem ? <span className="app-row-desc app-row-problem">{problem}</span> : <span className="app-row-desc">{app.description}</span>}
        </span>
      </button>
      {isConnected(view) ? (
        <button type="button" className="btn btn-sm app-row-action" onClick={onOpen}>
          Manage
        </button>
      ) : (
        <button type="button" className="btn btn-sm app-row-action" disabled={busy} onClick={() => void go()}>
          {busy ? <Spinner size={12} /> : view?.status === "needs-auth" || view?.status === "error" ? "Reconnect" : "Connect"}
        </button>
      )}
    </li>
  );
}

function Section({ title, apps, onOpen }: { title?: string; apps: CatalogApp[]; onOpen: (id: string) => void }) {
  if (!apps.length) return null;
  return (
    <section className="apps-section" aria-label={title}>
      {title && <h3 className="apps-section-title">{title}</h3>}
      <ul className="apps-list">
        {apps.map((app) => (
          <AppRow key={app.id} app={app} onOpen={() => onOpen(app.id)} />
        ))}
      </ul>
    </section>
  );
}

/** A value to copy, with a button that says whether it did. Failing, it selects the value to copy by hand. */
export function CopyLine({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState<"yes" | "no">();
  const code = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(value);
    setCopied(ok ? "yes" : "no");
    clearTimeout(timer.current);
    if (ok) timer.current = setTimeout(() => setCopied(undefined), 1400);
    else if (code.current) window.getSelection()?.selectAllChildren(code.current);
  };
  return (
    <>
      <div className="app-copy">
        <code ref={code}>{value}</code>
        <span className="app-copy-status" aria-live="polite">
          {copied === "yes" && "Copied"}
        </span>
        <IconButton label={copied === "yes" ? "Copied" : label} onClick={() => void copy()}>
          {copied === "yes" ? <Check size={14} className="ok" /> : <Copy size={14} />}
        </IconButton>
      </div>
      {copied === "no" && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> Couldn't copy it. It's selected: copy it with your keyboard.
        </p>
      )}
    </>
  );
}

/** One app: what it does, what connecting it takes, and what it gave bots. */
function AppPage({ app, onDone }: { app: CatalogApp; onDone: () => void }) {
  const view = useApps((s) => s.apps[app.id]);
  const clients = useApps((s) => s.clients);
  const githubKey = useApps((s) => s.githubKey);
  const [fields, setFields] = useState<Record<string, string>>(view?.fields ?? {});
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const c = app.connection;
  // Services whose client the server keeps just sign in; the rest take one pasted in here.
  const guide = c.kind === "client" && !OAUTH_CLIENTS[c.client].env ? OAUTH_CLIENTS[c.client] : undefined;
  const hasClient = c.kind === "client" && clients.includes(c.client);
  const connected = isConnected(view);
  // GitHub signs in with OpenBuild's GitHub credential: the GitHub App, or a token the user picks.
  const github = useGithub((s) => s.view);
  const [patShown, setPatShown] = useState(false);
  const githubMode = app.githubAuth ? github?.mode : undefined;
  // A token is in use (or the GitHub App can't be): show its field. A fresh install with nothing saved starts at the app.
  const usingPat = githubMode === "pat" && (!!github?.hasPat || !github?.legacy);
  const showPat = !app.githubAuth || patShown || usingPat || github?.configured === false;
  const canReuseKey = !!app.githubAuth && githubKey && githubMode === "pat";

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connectWith = (input: ConnectInput) => useApps.getState().connect(app.id, input).finally(() => (app.githubAuth ? useGithub.getState().load() : undefined));
  const connect = () => {
    const input: ConnectInput = {};
    if (app.fields?.length) input.fields = fields;
    if (guide && clientId.trim()) input.client = { id: clientId, secret: clientSecret };
    // Saving a connected app's settings is done once it's still connected after: the dialog closes.
    // A failure stays here with its error, as does a reconnect that's still signing in.
    const saving = connected;
    void run(async () => {
      await connectWith(input);
      const after = useApps.getState().apps[app.id];
      if (saving && isConnected(after) && !after?.signingIn) onDone();
    });
  };
  const finish = () => void run(() => useApps.getState().finish(app.id, pasted).then(() => setPasted("")));
  const pastes = pastesSignIn(app);
  const error = problem ?? (view?.status === "error" || view?.status === "needs-auth" ? view.error : undefined);

  return (
    <div className="bots-dialog-body app-page">
      <div className="app-page-head">
        <AppLogo app={app} size={48} />
        <div className="app-page-title">
          <h3>
            {app.name}
            <AppStatus view={view} />
          </h3>
          <p>
            Official, by {app.by} ·{" "}
            <a href={app.docs} target="_blank" rel="noreferrer">
              Docs <ExternalLink size={11} />
            </a>
          </p>
        </div>
      </div>
      <p className="app-page-desc">{app.description}</p>

      {c.kind === "local" && !connected && <p className="field-help">{c.install}</p>}
      {c.kind === "desktop" && !connected && <p className="field-help">{c.install}</p>}

      {guide && (
        <div className="app-guide">
          <div className="bots-field-label">{hasClient ? `Your ${guide.name} OAuth client` : `${app.by} needs an OAuth client of your own`}</div>
          {hasClient ? (
            <p className="field-help">
              Saved. Every {guide.name} app uses it.{" "}
              <button type="button" className="apps-link" disabled={busy} onClick={() => void run(() => useApps.getState().forgetClient(c.kind === "client" ? c.client : "google"))}>
                Forget it
              </button>
            </p>
          ) : (
            <ol className="app-steps">
              {guide.steps?.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          {!hasClient && (
            <>
              <CopyLine value={`${window.location.origin}${APP_CALLBACK_PATH}`} label="Copy redirect URI" />
              {c.kind === "client" && !!c.enable?.length && (
                <p className="field-help">
                  APIs to enable: <code>{c.enable.join(", ")}</code>
                </p>
              )}
              <p className="field-help">
                <a href={guide.console} target="_blank" rel="noreferrer">
                  Open {guide.name} <ExternalLink size={11} />
                </a>{" "}
                ·{" "}
                <a href={guide.docs} target="_blank" rel="noreferrer">
                  Their guide <ExternalLink size={11} />
                </a>
              </p>
              <label className="bots-field">
                <span className="bots-field-label">Client ID</span>
                <input className="input" value={clientId} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
              </label>
              <label className="bots-field">
                <span className="bots-field-label">Client secret{guide.secret === "optional" ? " (optional)" : ""}</span>
                <input className="input" type="password" value={clientSecret} autoComplete="off" onChange={(e) => setClientSecret(e.target.value)} />
              </label>
            </>
          )}
        </div>
      )}

      {app.githubAuth && <GithubSignIn patShown={showPat} onPat={() => setPatShown(true)} onConnected={() => run(() => connectWith({ fields }))} />}

      {app.fields?.filter((field) => !(app.githubAuth && field.id === "token" && !showPat)).map((field) => (
        <label key={field.id} className="bots-field">
          <span className="bots-field-label">{field.label}</span>
          {field.options ? (
            <select className="input" value={fields[field.id] ?? field.options[0]!.value} onChange={(e) => setFields({ ...fields, [field.id]: e.target.value })}>
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              type={field.secret ? "password" : "text"}
              value={fields[field.id] ?? ""}
              autoComplete="off"
              spellCheck={false}
              placeholder={connected && field.secret ? "Saved · paste a new one to replace it" : canReuseKey && field.secret ? "Using your GitHub key from Settings" : field.placeholder}
              onChange={(e) => setFields({ ...fields, [field.id]: e.target.value })}
            />
          )}
          {(field.help || field.link) && (
            <span className="field-help">
              {field.help}{" "}
              {field.link && (
                <a href={field.link} target="_blank" rel="noreferrer">
                  Get one <ExternalLink size={11} />
                </a>
              )}
            </span>
          )}
        </label>
      ))}

      {pastes && !connected && !view?.signingIn && <p className="field-help">{app.by} only returns sign-ins to localhost, so after signing in you'll paste the address back here.</p>}

      {pastes && view?.signingIn && (
        <form
          className="app-guide"
          onSubmit={(e) => {
            e.preventDefault();
            finish();
          }}
        >
          <label className="bots-field">
            <span className="bots-field-label">Finish signing in</span>
            <input className="input" value={pasted} autoComplete="off" spellCheck={false} placeholder="http://localhost…" onChange={(e) => setPasted(e.target.value)} />
            <span className="field-help">After you approve {app.name}, its tab lands on a page that won't load. Copy that tab's full address and paste it here.</span>
          </label>
          <div className="app-page-actions">
            <button type="submit" className="btn bots-btn bots-btn-primary" disabled={busy || !pasted.trim()}>
              {busy ? <Spinner size={13} /> : "Finish"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {error}
        </p>
      )}

      <div className="app-page-actions">
        {!(connected && c.kind === "open") && !(app.githubAuth && !showPat && githubMode !== "app") && (
          <button type="button" className={cx("btn bots-btn", !(pastes && view?.signingIn) && "bots-btn-primary")} disabled={busy} onClick={connect}>
            {busy ? <Spinner size={13} /> : connected && app.githubAuth ? "Save" : connected || view?.status === "needs-auth" || view?.status === "error" ? "Reconnect" : "Connect"}
          </button>
        )}
        {connected && (
          <button type="button" className="btn bots-btn" disabled={busy} onClick={() => void run(() => useApps.getState().check(app.id))}>
            Test connection
          </button>
        )}
        {view && view.status !== "off" && (
          <button type="button" className="btn bots-btn bots-danger" disabled={busy} onClick={() => void run(() => useApps.getState().disconnect(app.id))}>
            {/* GitHub's own sign-in has its Disconnect above; this only takes the app away from bots. */}
            {app.githubAuth ? "Remove from bots" : "Disconnect"}
          </button>
        )}
      </div>

      {connected && <p className="field-help">Bots use this as you, without seeing your sign-in.</p>}

      {!!view?.tools?.length && (
        <details className="app-details">
          <summary>{view.tools.length === 1 ? "1 tool" : `${view.tools.length} tools`}</summary>
          <ul>
            {view.tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                {t.description && <span>{t.description}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!!view?.skills?.length && (
        <details className="app-details">
          <summary>{view.skills.length === 1 ? "1 skill" : `${view.skills.length} skills`}</summary>
          <ul>
            {view.skills.map((k) => (
              <li key={k.name}>
                <code>{k.name}</code>
                {k.description && <span>{k.description}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!view?.skills?.length && !!app.skills?.length && !connected && <p className="field-help">Includes {app.by}'s skills, installed when you connect.</p>}
    </div>
  );
}

type Filter = "all" | "connected" | AppCategory;

function NavItem({ on, label, count, onClick }: { on: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" className="apps-nav-item" aria-current={on ? "true" : undefined} onClick={onClick}>
      <span className="apps-nav-label">{label}</span>
      <span className="apps-nav-count">{count}</span>
    </button>
  );
}

export function AppsDialog({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const modal = useModal(onClose);
  const apps = useApps((s) => s.apps);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | undefined>(initial);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useApps.getState().load().catch(() => {});
    // The sign-in popup says when it's done, in case the stream is reconnecting just then.
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === "openbots-app") void useApps.getState().load().catch(() => {});
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const connected = useMemo(() => APP_CATALOG.filter((a) => isConnected(apps[a.id])), [apps]);
  const page = open ? appById(open) : undefined;
  const words = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!words) return [];
    return APP_CATALOG.filter((a) => {
      const v = apps[a.id];
      const hay = [a.name, a.by, a.description, a.category, ...(v?.skills ?? []).flatMap((k) => [k.name, k.description]), ...(v?.tools ?? []).map((t) => t.name)].join(" ").toLowerCase();
      return words.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [words, apps]);
  const inCategory = (id: AppCategory) => APP_CATALOG.filter((a) => a.category === id);
  // Picking a category clears the search and starts its list at the top.
  const pick = (next: Filter) => {
    setFilter(next);
    setQuery("");
    list.current?.scrollTo({ top: 0 });
  };

  return (
    <dialog {...modal} className="bots-dialog apps-dialog" aria-label="Marketplace">
      {page ? (
        <>
          <div className="bots-dialog-head apps-page-head">
            <button type="button" className="apps-back" onClick={() => setOpen(undefined)}>
              <ArrowLeft size={15} /> Marketplace
            </button>
            <IconButton label="Close" tooltip={false} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          <AppPage key={page.id} app={page} onDone={onClose} />
        </>
      ) : (
        <>
          <div className="bots-dialog-head apps-head">
            <h2>Marketplace</h2>
            <label className="apps-search">
              <Search size={15} />
              <input type="search" value={query} placeholder="Search apps and skills" aria-label="Search apps and skills" autoFocus onChange={(e) => setQuery(e.target.value)} />
            </label>
            <IconButton label="Close" tooltip={false} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          <div className="apps-body">
            <nav className="apps-nav" aria-label="Categories">
              <NavItem on={!words && filter === "all"} label="All apps" count={APP_CATALOG.length} onClick={() => pick("all")} />
              <NavItem on={!words && filter === "connected"} label="Connected" count={connected.length} onClick={() => pick("connected")} />
              <span className="apps-nav-sep" aria-hidden />
              {APP_CATEGORIES.map((c) => (
                <NavItem key={c.id} on={!words && filter === c.id} label={c.label} count={inCategory(c.id).length} onClick={() => pick(c.id)} />
              ))}
            </nav>
            <div ref={list} className="apps-main">
              {words ? (
                matches.length ? (
                  <Section title={matches.length === 1 ? "1 result" : `${matches.length} results`} apps={matches} onOpen={setOpen} />
                ) : (
                  <p className="apps-empty">No apps match “{query.trim()}”.</p>
                )
              ) : filter === "all" ? (
                APP_CATEGORIES.map((c) => <Section key={c.id} title={c.label} apps={inCategory(c.id)} onOpen={setOpen} />)
              ) : filter === "connected" ? (
                connected.length ? (
                  <Section title="Connected" apps={connected} onOpen={setOpen} />
                ) : (
                  <p className="apps-empty">Nothing connected yet.</p>
                )
              ) : (
                <Section title={APP_CATEGORIES.find((c) => c.id === filter)!.label} apps={inCategory(filter)} onOpen={setOpen} />
              )}
            </div>
          </div>
        </>
      )}
    </dialog>
  );
}

/** A bot offering an app in a chat. */
export function ConnectCard({ appId }: { appId: string }) {
  const host = useRemoteWorkspace();
  const app = appById(appId);
  if (!app) return <div className="bm-text">This app isn't in the catalog anymore.</div>;
  return host ? <RemoteConnectCard app={app} host={host} /> : <LocalConnectCard app={app} />;
}

/**
 * A bot on another device offering an app: it would be connected there, in that device's own
 * session, so neither its state nor its logo is fetched from here, and the card says so.
 */
function RemoteConnectCard({ app, host }: { app: CatalogApp; host: string }) {
  return (
    <div className="bm-connect bm-unavailable-card">
      <span className="app-logo" style={{ width: 40, height: 40 }} aria-hidden>
        <span className="app-logo-letter">{app.name[0]}</span>
      </span>
      <div className="bm-connect-text">
        <div className="bm-question-title">{app.name}</div>
        <div className="bm-question-hint">Apps for these bots are connected on {host}. Connect {app.name} there.</div>
      </div>
    </div>
  );
}

function LocalConnectCard({ app }: { app: CatalogApp }) {
  const appId = app.id;
  const view = useApps((s) => s.apps[appId]);
  const loaded = useApps((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useApps.getState().load().catch(() => {});
  }, [loaded]);
  return (
    <div className="bm-connect">
      <AppLogo app={app} />
      <div className="bm-connect-text">
        <div className="bm-question-title">{app.name}</div>
        <div className="bm-question-hint">{app.description}</div>
      </div>
      {isConnected(view) ? (
        <span className="bm-connect-done">Connected</span>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => openBotsDialog({ kind: "apps", app: app.id })}>
          Connect
        </button>
      )}
    </div>
  );
}
