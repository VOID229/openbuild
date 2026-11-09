// OpenBots' Marketplace: a page of its own with a catalog of official MCP servers and skills to search
// and browse, a page for each app with whatever it takes to connect it, and the card a bot posts to
// offer one in a chat.
import { Check, ChevronDown, CircleAlert, Copy, ExternalLink, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { APP_CALLBACK_PATH, APP_CATALOG, APP_CATEGORIES, appById, OAUTH_CLIENTS, type AppCategory, type AppView, type CatalogApp } from "../../../shared/apps";
import { isConnected, pastesSignIn, useApps, type ConnectInput } from "../../lib/bots/apps";
import { useRemoteWorkspace } from "../../lib/bots/store";
import { useGithub } from "../../lib/github";
import { leaveMarketplace, marketplaceBack, marketplaceUp, openMarketplaceApp } from "../../lib/pages";
import { useStore } from "../../lib/store";
import { copyText, cx, useMediaQuery } from "../../lib/ui";
import { useLightbox } from "../Lightbox";
import { IconButton, Spinner } from "../primitives";
import { Hint, PageHeader } from "../SettingsUI";
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

function AppStatus({ view, pill }: { view?: AppView; pill?: boolean }) {
  const status = statusOf(view);
  if (!status) return null;
  return (
    <span className={cx("app-status", `app-status-${status.tone}`, pill && "app-status-pill")}>
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

/** A hairline card on an app's page, one per concern: Connection, Permissions, Tools, Danger zone. */
export function AppCard({ title, aside, foot, danger, children, className }: { title?: ReactNode; aside?: ReactNode; foot?: ReactNode; danger?: boolean; children?: ReactNode; className?: string }) {
  return (
    <section className={cx("app-card", danger && "app-card-danger", className)} aria-label={typeof title === "string" ? title : undefined}>
      {title && (
        <header className="app-card-head">
          <h3 className="app-card-title">{title}</h3>
          {aside}
        </header>
      )}
      {children}
      {foot && <div className="app-card-foot">{foot}</div>}
    </section>
  );
}

/** A row in a card: what it is on the left, with one dim line under it at most (more goes in `hint`), and its control on the right. */
export function AppRowLine({ label, desc, hint, lead, children, className }: { label: ReactNode; desc?: ReactNode; hint?: string; lead?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("app-card-row", className)}>
      {lead}
      <div className="app-card-text">
        <div className="app-card-label">
          {label}
          {hint && <Hint text={hint} />}
        </div>
        {desc && <div className="app-card-desc">{desc}</div>}
      </div>
      {children && <div className="app-card-control">{children}</div>}
    </div>
  );
}

/** A problem to show where it happened. */
export function AppAlert({ children }: { children: ReactNode }) {
  return (
    <p className="app-alert key-status key-status-bad" role="alert">
      <CircleAlert size={13} className="bad" /> {children}
    </p>
  );
}

/** What connecting gave bots, folded away under its count. */
function ListCard({ title, items }: { title: string; items: { name: string; description?: string }[] }) {
  return (
    <details className="app-card app-list-card">
      <summary className="app-card-head">
        <h3 className="app-card-title">{title}</h3>
        <span className="app-card-count">{items.length}</span>
        <ChevronDown size={15} className="app-card-chevron" aria-hidden />
      </summary>
      <ul className="app-list">
        {items.map((t) => (
          <li key={t.name}>
            <code>{t.name}</code>
            {t.description && <span>{t.description}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

const shortDate = (at: number) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

/**
 * One app's page: a header (logo, name, its state, the main action), then a card for each concern:
 * connecting it, what bots may do with it, what it gave them, and taking it away again.
 */
export function AppPage({ app, onDone }: { app: CatalogApp; onDone: () => void }) {
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

  // Opened on its own (a link, a test), it fetches where the apps stand; the Marketplace has usually done that already.
  useEffect(() => {
    if (!useApps.getState().loaded) void useApps.getState().load().catch(() => {});
  }, []);
  // Its saved settings arrive with it, when that's after the page opened.
  const savedFields = view?.fields;
  useEffect(() => {
    if (savedFields) setFields((now) => (Object.keys(now).length ? now : savedFields));
  }, [savedFields]);

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
    // Saving a connected app's settings is done once it's still connected after: the page goes back.
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

  // Choices (GitHub's access, a Datadog site) are settings; the rest (keys, tokens) are what connecting takes.
  const choices = app.fields?.filter((f) => f.options) ?? [];
  const inputs = app.fields?.filter((f) => !f.options && !(app.githubAuth && f.id === "token" && !showPat)) ?? [];
  const setField = (id: string, value: string) => setFields({ ...fields, [id]: value });
  // GitHub's own sign-in has its own button until it's signed in; a connected open server has nothing to send.
  const hasAction = !(connected && c.kind === "open") && !(app.githubAuth && !showPat && githubMode !== "app");
  const saves = connected && !!app.githubAuth;
  const reconnects = connected || view?.status === "needs-auth" || view?.status === "error";
  const action = (
    <button type="button" className={cx("btn bots-btn", !(pastes && view?.signingIn) && "bots-btn-primary")} disabled={busy} onClick={connect}>
      {busy ? <Spinner size={13} /> : saves ? "Save" : reconnects ? "Reconnect" : "Connect"}
    </button>
  );
  // Keys and an OAuth client are typed in the Connection card, so its button sits under them; otherwise it's the header's.
  const typesIn = inputs.length > 0 || (!!guide && !hasClient);
  const actionInHeader = hasAction && !saves && !typesIn;
  const setup = (c.kind === "local" || c.kind === "desktop") && !connected ? c.install : undefined;
  // Nothing to fill in or set up: the card still says how connecting goes.
  const plain = !setup && !guide && !app.githubAuth && !inputs.length && !pastes && !connected;

  return (
    <div className="app-page">
      <header className="app-hero">
        <AppLogo app={app} size={56} />
        <div className="app-hero-text">
          <h2 className="app-hero-name">
            {app.name}
            <AppStatus view={view} pill />
          </h2>
          <p className="app-hero-desc">{app.description}</p>
          <p className="app-hero-meta">
            Official, by {app.by}
            <span aria-hidden> · </span>
            <a href={app.docs} target="_blank" rel="noreferrer">
              Docs <ExternalLink size={11} />
            </a>
          </p>
        </div>
        {(actionInHeader || connected) && (
          <div className="app-hero-actions">
            {connected && (
              <button type="button" className="btn bots-btn" disabled={busy} onClick={() => void run(() => useApps.getState().check(app.id))}>
                Test connection
              </button>
            )}
            {actionInHeader && action}
          </div>
        )}
      </header>

      <AppCard title="Connection" foot={hasAction && !saves && typesIn ? <div className="app-page-actions">{action}</div> : undefined}>
        {setup && <AppRowLine label="Before connecting" desc={setup} />}
        {plain && <AppRowLine label="Not connected" desc={c.kind === "open" ? "No sign-in needed: it connects straight away." : `Connecting opens ${app.by}'s sign-in.`} />}

        {guide &&
          (hasClient ? (
            <AppRowLine label={`${guide.name} OAuth client`} desc={`Saved. Every ${guide.name} app uses it.`}>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => useApps.getState().forgetClient(c.kind === "client" ? c.client : "google"))}>
                Forget
              </button>
            </AppRowLine>
          ) : (
            <div className="app-card-block app-oauth">
              <div className="app-card-label">{`${app.by} needs an OAuth client of your own`}</div>
              <ol className="app-steps">
                {guide.steps?.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <CopyLine value={`${window.location.origin}${APP_CALLBACK_PATH}`} label="Copy redirect URI" />
              {c.kind === "client" && !!c.enable?.length && (
                <p className="app-card-desc">
                  APIs to enable: <code>{c.enable.join(", ")}</code>
                </p>
              )}
              <div className="app-page-actions">
                <a className="btn btn-sm" href={guide.console} target="_blank" rel="noreferrer">
                  Open {guide.name} <ExternalLink size={12} />
                </a>
                <a className="btn btn-sm" href={guide.docs} target="_blank" rel="noreferrer">
                  Their guide <ExternalLink size={12} />
                </a>
              </div>
              <label className="bots-field">
                <span className="bots-field-label">Client ID</span>
                <input className="input input-sm" value={clientId} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
              </label>
              <label className="bots-field">
                <span className="bots-field-label">
                  Client secret{guide.secret === "optional" && <span className="bots-field-optional"> · optional</span>}
                </span>
                <input className="input input-sm" type="password" value={clientSecret} autoComplete="off" onChange={(e) => setClientSecret(e.target.value)} />
              </label>
            </div>
          ))}

        {app.githubAuth && <GithubSignIn part="connection" patShown={showPat} onPat={() => setPatShown(true)} onConnected={() => run(() => connectWith({ fields }))} />}

        {inputs.length > 0 && (
          <div className="app-card-block">
            {inputs.map((field) => (
              <label key={field.id} className="bots-field">
                <span className="bots-field-label">{field.label}</span>
                <input
                  className="input input-sm"
                  type={field.secret ? "password" : "text"}
                  value={fields[field.id] ?? ""}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={connected && field.secret ? "Saved · paste a new one to replace it" : canReuseKey && field.secret ? "Using your GitHub key from Settings" : field.placeholder}
                  onChange={(e) => setField(field.id, e.target.value)}
                />
                {(field.help || field.link) && (
                  <span className="app-card-desc">
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
          </div>
        )}

        {pastes && !connected && !view?.signingIn && <AppRowLine label="Sign-in" desc={`${app.by} only returns sign-ins to localhost: you'll paste the address back here.`} />}

        {pastes && view?.signingIn && (
          <form
            className="app-card-block"
            onSubmit={(e) => {
              e.preventDefault();
              finish();
            }}
          >
            <label className="bots-field">
              <span className="bots-field-label">Finish signing in</span>
              <input className="input input-sm" value={pasted} autoComplete="off" spellCheck={false} placeholder="http://localhost…" onChange={(e) => setPasted(e.target.value)} />
              <span className="app-card-desc">After you approve {app.name}, its tab lands on a page that won't load. Paste that tab's address here.</span>
            </label>
            <div className="app-page-actions">
              <button type="submit" className="btn bots-btn bots-btn-primary" disabled={busy || !pasted.trim()}>
                {busy ? <Spinner size={13} /> : "Finish"}
              </button>
            </div>
          </form>
        )}

        {connected && !app.githubAuth && <AppRowLine label={view?.connectedAt ? `Connected ${shortDate(view.connectedAt)}` : "Connected"} desc="Bots use it as you, without seeing your sign-in." />}

        {error && (
          <div className="app-card-block">
            <AppAlert>{error}</AppAlert>
          </div>
        )}
      </AppCard>

      {choices.length > 0 && (
        <AppCard title={choices.some((f) => f.id === "access") ? "Permissions" : "Settings"} foot={saves && hasAction ? <div className="app-page-actions">{action}</div> : undefined}>
          {choices.map((field) => (
            <AppRowLine key={field.id} label={field.label} hint={field.help}>
              <select className="input input-sm app-select" aria-label={field.label} value={fields[field.id] ?? field.options![0]!.value} onChange={(e) => setField(field.id, e.target.value)}>
                {field.options!.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </AppRowLine>
          ))}
        </AppCard>
      )}

      {!!view?.tools?.length && <ListCard title="Tools" items={view.tools} />}
      {!!view?.skills?.length && <ListCard title="Skills" items={view.skills} />}
      {!view?.skills?.length && !!app.skills?.length && !connected && (
        <AppCard>
          <AppRowLine label="Skills" desc={`${app.by}'s skills install when you connect.`} />
        </AppCard>
      )}

      {((view && view.status !== "off") || (app.githubAuth && github?.mode === "app" && github.app)) && (
        <AppCard title="Danger zone" danger>
          {view && view.status !== "off" && (
            <AppRowLine label={app.githubAuth ? "Remove from bots" : "Disconnect"} desc={app.githubAuth ? "Bots lose GitHub's tools. Your GitHub sign-in stays." : "Bots lose its tools. You can connect it again any time."}>
              <button type="button" className="btn btn-sm app-danger-btn" disabled={busy} onClick={() => void run(() => useApps.getState().disconnect(app.id))}>
                {app.githubAuth ? "Remove" : "Disconnect"}
              </button>
            </AppRowLine>
          )}
          {app.githubAuth && <GithubSignIn part="danger" patShown={showPat} onPat={() => setPatShown(true)} onConnected={() => run(() => connectWith({ fields }))} />}
        </AppCard>
      )}
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

/**
 * OpenBots' Marketplace, a page in the main pane like Settings: the catalog, with its categories down
 * the left, or one app's page. Back, Esc and the browser's back step up from an app to the catalog,
 * then out to wherever the Marketplace was opened from (pages.ts); the sidebar stays as it was.
 */
export function MarketplacePage() {
  const appId = useStore((s) => s.marketplaceApp);
  const phone = useMediaQuery("(max-width: 768px)");
  const apps = useApps((s) => s.apps);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const app = appId ? appById(appId) : undefined;

  useEffect(() => {
    void useApps.getState().load().catch(() => {});
    // The sign-in popup says when it's done, in case the stream is reconnecting just then.
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === "openbots-app") void useApps.getState().load().catch(() => {});
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // An app that isn't in the catalog (an old link) is the catalog.
  useEffect(() => {
    if (appId && !app) useStore.setState({ marketplaceApp: undefined });
  }, [appId, app]);

  // An app's page starts at its top, with focus on the page so Esc and the keyboard work from there.
  useLayoutEffect(() => {
    if (page.current) page.current.scrollTop = 0;
    if (app && !root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
    else if (document.activeElement === document.body) root.current?.focus({ preventScroll: true });
  }, [app?.id]);

  // One step back: from an app to the catalog it was opened from (or out, opened straight at it), then out of the Marketplace.
  const goBack = app ? marketplaceBack : leaveMarketplace;
  const latest = useRef(goBack);
  latest.current = goBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      // Whatever is over the page (a dialog, a menu, a lightbox) takes its own Escape.
      if (useLightbox.getState().open || document.querySelector("dialog[open], .modal-root, .popover-portal, .context-menu")) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && el.closest("[role='menu'], [role='listbox'], [role='dialog']")) return;
      // A field with something in it keeps it (a search clears itself); an empty one doesn't hold the page.
      if (el instanceof HTMLInputElement && el.value) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const connected = useMemo(() => APP_CATALOG.filter((a) => isConnected(apps[a.id])), [apps]);
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

  const search = (
    <label className="apps-search">
      <Search size={15} />
      <input type="search" value={query} placeholder="Search apps and skills" aria-label="Search apps and skills" autoFocus={!phone && !app} onChange={(e) => setQuery(e.target.value)} />
    </label>
  );
  // An app's page names where it sits: "Marketplace / GitHub", the first a way to the catalog.
  const title = app && !phone ? (
    <span className="mpage-trail">
      <button type="button" className="mpage-crumb" onClick={marketplaceUp}>
        Marketplace
      </button>
      <span className="mpage-sep" aria-hidden>
        /
      </span>
      {app.name}
    </span>
  ) : app ? (
    app.name
  ) : (
    "Marketplace"
  );

  return (
    <div ref={root} className="spage mpage" role="region" aria-label="Marketplace" tabIndex={-1}>
      <PageHeader title={title} onBack={goBack} />
      {/* The catalog stays mounted under an app's page, so coming back finds it as it was left. */}
      <div className="apps-body mpage-body" hidden={!!app}>
        {phone && <div className="mpage-search">{search}</div>}
        <nav className="apps-nav" aria-label="Categories">
          <NavItem on={!words && filter === "all"} label="All apps" count={APP_CATALOG.length} onClick={() => pick("all")} />
          <NavItem on={!words && filter === "connected"} label="Connected" count={connected.length} onClick={() => pick("connected")} />
          <span className="apps-nav-sep" aria-hidden />
          {APP_CATEGORIES.map((c) => (
            <NavItem key={c.id} on={!words && filter === c.id} label={c.label} count={inCategory(c.id).length} onClick={() => pick(c.id)} />
          ))}
        </nav>
        <div ref={list} className="apps-main">
          {!phone && search}
          {words ? (
            matches.length ? (
              <Section title={matches.length === 1 ? "1 result" : `${matches.length} results`} apps={matches} onOpen={openMarketplaceApp} />
            ) : (
              <p className="apps-empty">No apps match “{query.trim()}”.</p>
            )
          ) : filter === "all" ? (
            APP_CATEGORIES.map((c) => <Section key={c.id} title={c.label} apps={inCategory(c.id)} onOpen={openMarketplaceApp} />)
          ) : filter === "connected" ? (
            connected.length ? (
              <Section title="Connected" apps={connected} onOpen={openMarketplaceApp} />
            ) : (
              <p className="apps-empty">Nothing connected yet.</p>
            )
          ) : (
            <Section title={APP_CATEGORIES.find((c) => c.id === filter)!.label} apps={inCategory(filter)} onOpen={openMarketplaceApp} />
          )}
        </div>
      </div>
      {app && (
        <div ref={page} className="mpage-scroll">
          <div className="mpage-inner">
            <AppPage key={app.id} app={app} onDone={marketplaceBack} />
          </div>
        </div>
      )}
    </div>
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
        <button type="button" className="btn btn-sm" onClick={() => useStore.getState().openMarketplace(app.id)}>
          Connect
        </button>
      )}
    </div>
  );
}
