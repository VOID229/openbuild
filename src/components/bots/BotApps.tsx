// OpenBots' Connect Apps: a catalog of official MCP servers and skills to search and browse, a page
// for each app with whatever it takes to connect it, and the card a bot posts to offer one in a chat.
import { ArrowLeft, ChevronDown, ChevronRight, CircleAlert, Copy, ExternalLink, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { APP_CALLBACK_PATH, APP_CATALOG, APP_CATEGORIES, appById, OAUTH_CLIENTS, type AppCategory, type AppView, type CatalogApp } from "../../../shared/apps";
import { isConnected, useApps, type ConnectInput } from "../../lib/bots/apps";
import { arrowNav, copyText, cx } from "../../lib/ui";
import { IconButton, Popover, Spinner } from "../primitives";
import { DialogHead, useModal } from "./BotDialogs";
import { openBotsDialog } from "./BotsSidebar";

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

function statusText(view?: AppView) {
  if (view?.status === "connected") return "Connected";
  if (view?.status === "needs-auth") return "Signed out";
  if (view?.status === "error") return "Couldn't connect";
  if (view?.status === "connecting") return "Waiting for sign-in";
  return undefined;
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
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status = statusText(view);
  return (
    <div className="app-row">
      <button type="button" className="app-row-main" onClick={onOpen}>
        <AppLogo app={app} size={32} />
        <span className="app-row-text">
          <span className="app-row-name">{app.name}</span>
          {problem ? <span className="app-row-status bad">{problem}</span> : status && <span className={cx("app-row-status", view?.status === "connected" ? "app-row-status-on" : view?.status !== "connecting" && "bad")}>{status}</span>}
        </span>
      </button>
      {isConnected(view) ? (
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          Manage
        </button>
      ) : (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void go()}>
          {busy ? <Spinner size={12} /> : view?.status === "needs-auth" || view?.status === "error" ? "Reconnect" : "Connect"}
        </button>
      )}
    </div>
  );
}

function Section({ title, apps, onOpen, onAll }: { title: string; apps: CatalogApp[]; onOpen: (id: string) => void; onAll?: () => void }) {
  if (!apps.length) return null;
  return (
    <section className="apps-section">
      <div className="apps-section-head">
        <h3>{title}</h3>
        {onAll && (
          <button type="button" className="apps-view-all" onClick={onAll}>
            View all
          </button>
        )}
      </div>
      <div className="apps-grid">
        {apps.map((app) => (
          <AppRow key={app.id} app={app} onOpen={() => onOpen(app.id)} />
        ))}
      </div>
    </section>
  );
}

function CopyLine({ value, label }: { value: string; label: string }) {
  return (
    <div className="app-copy">
      <code>{value}</code>
      <IconButton label={label} onClick={() => void copyText(value)}>
        <Copy size={14} />
      </IconButton>
    </div>
  );
}

/** One app: what it does, what connecting it takes, and what it gave bots. */
function AppPage({ app, onBack }: { app: CatalogApp; onBack: () => void }) {
  const view = useApps((s) => s.apps[app.id]);
  const clients = useApps((s) => s.clients);
  const githubKey = useApps((s) => s.githubKey);
  const [fields, setFields] = useState<Record<string, string>>(view?.fields ?? {});
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const c = app.connection;
  // Services whose client the server keeps just sign in; the rest take one pasted in here.
  const guide = c.kind === "client" && !OAUTH_CLIENTS[c.client].env ? OAUTH_CLIENTS[c.client] : undefined;
  const hasClient = c.kind === "client" && clients.includes(c.client);
  const connected = isConnected(view);
  const canReuseKey = app.id === "github" && githubKey;

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
  const connect = () => {
    const input: ConnectInput = {};
    if (app.fields?.length) input.fields = fields;
    if (guide && clientId.trim()) input.client = { id: clientId, secret: clientSecret };
    void run(() => useApps.getState().connect(app.id, input));
  };
  const error = problem ?? (view?.status === "error" || view?.status === "needs-auth" ? view.error : undefined);

  return (
    <div className="bots-dialog-body app-page">
      <button type="button" className="apps-back" onClick={onBack}>
        <ArrowLeft size={15} /> All apps
      </button>
      <div className="app-page-head">
        <AppLogo app={app} size={44} />
        <div className="app-page-title">
          <h3>{app.name}</h3>
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

      {app.fields?.map((field) => (
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
              placeholder={connected && field.secret ? "Saved. Paste a new one to replace it." : canReuseKey && field.secret ? "Uses your GitHub key from Settings. Paste another to use that." : field.placeholder}
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

      {error && (
        <p className="field-help key-status key-status-bad" role="alert">
          <CircleAlert size={13} className="bad" /> {error}
        </p>
      )}

      <div className="app-page-actions">
        {!(connected && c.kind === "open") && (
          <button type="button" className="btn bots-btn bots-btn-primary" disabled={busy} onClick={connect}>
            {busy ? <Spinner size={13} /> : connected || view?.status === "needs-auth" || view?.status === "error" ? "Reconnect" : "Connect"}
          </button>
        )}
        {connected && (
          <button type="button" className="btn bots-btn" disabled={busy} onClick={() => void run(() => useApps.getState().check(app.id))}>
            Check it
          </button>
        )}
        {view && view.status !== "off" && (
          <button type="button" className="btn bots-btn bots-danger" disabled={busy} onClick={() => void run(() => useApps.getState().disconnect(app.id))}>
            Disconnect
          </button>
        )}
      </div>

      {connected && <p className="field-help">Every bot can use this as you. Bots never see the sign-in itself.</p>}

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
      {!view?.skills?.length && !!app.skills?.length && !connected && <p className="field-help">Comes with {app.by}'s own skills, installed when you connect.</p>}
    </div>
  );
}

type Filter = "all" | "connected" | AppCategory;

export function AppsDialog({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const modal = useModal(onClose);
  const apps = useApps((s) => s.apps);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | undefined>(initial);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

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
  const chips = APP_CATEGORIES.filter((c) => !c.more);
  const extras = APP_CATEGORIES.filter((c) => c.more);
  const extraPicked = extras.find((c) => c.id === filter);

  return (
    <dialog {...modal} className="bots-dialog apps-dialog" aria-label="Connect Apps">
      <DialogHead title="Connect Apps" onClose={onClose} />
      {page ? (
        <AppPage key={page.id} app={page} onBack={() => setOpen(undefined)} />
      ) : (
        <div className="bots-dialog-body apps-body">
          <div className="apps-tools">
            <label className="search apps-search">
              <Search size={16} />
              <input type="text" value={query} placeholder="Search across apps and skills" aria-label="Search across apps and skills" autoFocus onChange={(e) => setQuery(e.target.value)} />
            </label>
            <button type="button" className="apps-connected" disabled={!connected.length} onClick={() => setFilter(filter === "connected" ? "all" : "connected")}>
              {connected.slice(0, 4).map((a) => (
                <AppLogo key={a.id} app={a} size={22} />
              ))}
              <span>{connected.length} connected</span>
              <ChevronRight size={14} />
            </button>
          </div>
          {!words && (
            <div className="apps-chips" role="group" aria-label="Categories">
              <button type="button" className={cx("apps-chip", filter === "all" && "apps-chip-on")} onClick={() => setFilter("all")}>
                All
              </button>
              {chips.map((c) => (
                <button key={c.id} type="button" className={cx("apps-chip", filter === c.id && "apps-chip-on")} onClick={() => setFilter(c.id)}>
                  {c.label}
                </button>
              ))}
              {!!extras.length && (
                <>
                  <button ref={moreRef} type="button" className={cx("apps-chip", extraPicked && "apps-chip-on")} aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}>
                    {extraPicked?.label ?? "More"} <ChevronDown size={14} />
                  </button>
                  <Popover open={more} onClose={() => setMore(false)} anchor={moreRef} className="menu" role="menu" label="More categories" fixed="down">
                    <div onKeyDown={(e) => arrowNav(e)}>
                      {extras.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          role="menuitem"
                          className="menu-item"
                          onClick={() => {
                            setMore(false);
                            setFilter(c.id);
                          }}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </Popover>
                </>
              )}
            </div>
          )}
          {words ? (
            matches.length ? (
              <Section title={`${matches.length} found`} apps={matches} onOpen={setOpen} />
            ) : (
              <p className="pi-empty">Nothing matches that.</p>
            )
          ) : filter === "all" ? (
            <>
              <Section title="Recommended for you" apps={APP_CATALOG.filter((a) => a.recommended && !isConnected(apps[a.id])).slice(0, 6)} onOpen={setOpen} />
              {APP_CATEGORIES.map((c) => {
                const list = inCategory(c.id);
                return <Section key={c.id} title={c.label} apps={list.slice(0, 6)} onOpen={setOpen} onAll={list.length > 6 ? () => setFilter(c.id) : undefined} />;
              })}
            </>
          ) : filter === "connected" ? (
            <Section title="Connected" apps={connected} onOpen={setOpen} />
          ) : (
            <Section title={APP_CATEGORIES.find((c) => c.id === filter)!.label} apps={inCategory(filter)} onOpen={setOpen} />
          )}
        </div>
      )}
    </dialog>
  );
}

/** A bot offering an app in a chat. */
export function ConnectCard({ appId }: { appId: string }) {
  const app = appById(appId);
  const view = useApps((s) => s.apps[appId]);
  const loaded = useApps((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useApps.getState().load().catch(() => {});
  }, [loaded]);
  if (!app) return <div className="bm-text">This app isn't in the catalog anymore.</div>;
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
