// GitHub credentials for everything OpenBuild does with GitHub: the page reader, app skills, the
// release check and the GitHub app bots use. One record in the vault (`github-auth`) says which
// credential is in use — the GitHub App's user token, a personal access token, or none — and only
// that one is ever used: disconnecting the app doesn't fall back to an old token.
//
// The app's tokens come from GitHub's device flow, which takes only the public client ID, and are
// refreshed the same way (GitHub doesn't ask for the client secret for device-flow tokens). A
// refresh rotates both tokens, so refreshes run one at a time and the new pair is written in one
// step, and only if the record is still the one the refresh started from: a disconnect while a
// refresh is under way can't be undone by it. Tokens never leave the server. See docs/github.md.
import { GITHUB_APP, installUrls, manageUrl, type DeviceStatus, type GithubInstallation, type GithubMode, type GithubView } from "../../shared/github";
import { GITHUB_SCOPE } from "../../shared/types";
import * as vault from "../vault";

const RECORD = "github-auth";
/** The GitHub app bots use keeps a pasted token of its own (see bots/mcp.ts). */
const BOT_APP_SECRETS = "app:github";
/** Refresh this long before the access token runs out. */
const SKEW = 5 * 60_000;
const TIMEOUT = 20_000;

interface AppTokens {
  access: string;
  accessExpiresAt?: number;
  refresh?: string;
  refreshExpiresAt?: number;
  login: string;
  userId: number;
  signedOut?: boolean;
}

interface GithubRecord {
  mode: GithubMode;
  /** Changes whenever the credential does, so work started on an older one can't write over it. */
  generation: string;
  app?: AppTokens;
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// Other hosts are for tests: a stand-in for GitHub (tests/fakeGithub.ts).
const oauthOrigin = () => process.env.OPENBUILD_GITHUB_ORIGIN || "https://github.com";
const apiOrigin = () => process.env.OPENBUILD_GITHUB_API_ORIGIN || "https://api.github.com";

export function appConfig() {
  return {
    clientId: process.env.OPENBUILD_GITHUB_APP_CLIENT_ID?.trim() || GITHUB_APP.clientId,
    slug: process.env.OPENBUILD_GITHUB_APP_SLUG?.trim() || GITHUB_APP.slug,
  };
}

const read = () => vault.getJson<GithubRecord>(RECORD);

const listeners = new Set<() => void | Promise<void>>();
/** Called after the user connects, disconnects or picks another credential. */
export function onGithubChange(listener: () => void | Promise<void>) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
async function changed() {
  for (const listener of listeners) await Promise.resolve(listener()).catch((err) => console.error("[github]", err instanceof Error ? err.message : err));
}
const generation = () => crypto.randomUUID();

async function settingsPat(): Promise<string | undefined> {
  const [key] = await vault.secrets(GITHUB_SCOPE).catch(() => [] as string[]);
  return key;
}

async function botAppPat(): Promise<string | undefined> {
  return (await vault.getJson<{ fields?: Record<string, string> }>(BOT_APP_SECRETS))?.fields?.token;
}

export type Purpose = "reader" | "skills" | "releases" | "mcp";

/**
 * The token to call GitHub with, from the credential the user chose, or nothing. With no choice
 * made yet (an install from before the GitHub App) that's the saved personal access token, as
 * before. `pasted` is the token pasted into the bots' GitHub app, which it uses first.
 * `refresh: false` is for code that may run outside the server (the CLI): only the server refreshes.
 */
export async function githubToken(purpose: Purpose, opts: { pasted?: string; refresh?: boolean } = {}): Promise<{ token: string; source: "app" | "pat" } | undefined> {
  const record = await read();
  if (!record || record.mode === "pat") {
    const token = (purpose === "mcp" ? opts.pasted : undefined) ?? (await settingsPat());
    return token ? { token, source: "pat" } : undefined;
  }
  if (record.mode === "off") return undefined;
  const token = await appAccess(opts.refresh !== false);
  return token ? { token, source: "app" } : undefined;
}

const kept = globalThis as { openbuildGithubRefresh?: Map<string, Promise<string | undefined>>; openbuildGithubFlows?: Map<string, Flow>; openbuildGithubStarts?: { n: number } };
const refreshing = (kept.openbuildGithubRefresh ??= new Map());

async function appAccess(allowRefresh: boolean): Promise<string | undefined> {
  const record = await read();
  const app = record?.mode === "app" ? record.app : undefined;
  if (!record || !app || app.signedOut) return undefined;
  if (!app.accessExpiresAt || app.accessExpiresAt - Date.now() > SKEW) return app.access;
  if (!allowRefresh) return app.accessExpiresAt > Date.now() ? app.access : undefined;
  // One refresh per credential: everyone waiting gets its result.
  let run = refreshing.get(record.generation);
  if (!run) {
    run = refresh(record).finally(() => refreshing.delete(record.generation));
    refreshing.set(record.generation, run);
  }
  return run;
}

/** Change the record only if it's still the credential `from` (the same generation, still the app). */
async function commitApp(from: string, change: (app: AppTokens) => AppTokens): Promise<boolean> {
  let committed = false;
  await vault.updateJson<GithubRecord>(RECORD, (current) => {
    if (!current || current.generation !== from || current.mode !== "app" || !current.app) return current;
    committed = true;
    return { ...current, app: change(current.app) };
  });
  return committed;
}

const signOut = (from: string) => commitApp(from, (app) => ({ ...app, signedOut: true }));

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  interval?: number;
}

function tokensFrom(body: TokenResponse, now = Date.now()) {
  if (typeof body.access_token !== "string" || !body.access_token) return undefined;
  return {
    access: body.access_token,
    accessExpiresAt: typeof body.expires_in === "number" ? now + body.expires_in * 1000 : undefined,
    refresh: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    refreshExpiresAt: typeof body.refresh_token_expires_in === "number" ? now + body.refresh_token_expires_in * 1000 : undefined,
  };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${oauthOrigin()}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return ((await res.json().catch(() => ({}))) ?? {}) as TokenResponse;
}

async function refresh(record: GithubRecord): Promise<string | undefined> {
  const app = record.app!;
  const { clientId } = appConfig();
  if (!clientId || !app.refresh || (app.refreshExpiresAt && app.refreshExpiresAt <= Date.now())) {
    await signOut(record.generation);
    return undefined;
  }
  let body: TokenResponse;
  try {
    // No client secret: GitHub doesn't ask for one to refresh a token from the device flow.
    body = await tokenRequest({ client_id: clientId, grant_type: "refresh_token", refresh_token: app.refresh });
  } catch {
    // Offline or timed out: the stored tokens stand, and the next use tries again.
    return undefined;
  }
  const tokens = tokensFrom(body);
  if (!tokens) {
    if (body.error === "bad_refresh_token" || body.error === "invalid_grant" || body.error === "unauthorized") await signOut(record.generation);
    return undefined;
  }
  // GitHub has already retired the old pair, so the new one is saved before anything uses it.
  const saved = await commitApp(record.generation, (current) => ({ ...current, ...tokens, refresh: tokens.refresh ?? current.refresh, refreshExpiresAt: tokens.refreshExpiresAt ?? current.refreshExpiresAt }));
  return saved ? tokens.access : undefined;
}

// ------------------------------------------------------------------ choosing a credential

export async function view(): Promise<GithubView> {
  const record = await read();
  const { clientId, slug } = appConfig();
  const app = record?.mode === "app" ? record.app : undefined;
  const urls = slug ? installUrls(slug, app?.userId) : undefined;
  return {
    configured: !!clientId,
    mode: record?.mode ?? "pat",
    legacy: !record,
    hasPat: !!((await settingsPat()) || (await botAppPat())),
    ...(app ? { app: { login: app.login, userId: app.userId, signedOut: !!app.signedOut, refreshExpiresAt: app.refreshExpiresAt } } : {}),
    ...(urls && app ? { installPersonalUrl: urls.personal, installOrgUrl: urls.org } : {}),
  };
}

/**
 * Stop using the app here. The tokens are deleted from this server; the authorization on GitHub
 * stays until the user revokes it there (only they can, and only the app's secret could do it from
 * here). A saved personal access token stays saved but unused until the user picks it again.
 */
export async function disconnect(): Promise<void> {
  cancelAllFlows();
  await vault.updateJson<GithubRecord>(RECORD, () => ({ mode: "off", generation: generation() }));
  await changed();
}

/** Use the saved personal access token. The user picks this; nothing falls back to it. */
export async function usePat(): Promise<void> {
  if (!((await settingsPat()) || (await botAppPat()))) throw new GithubError("There's no personal access token saved. Paste one in the GitHub app first.");
  cancelAllFlows();
  await vault.updateJson<GithubRecord>(RECORD, () => ({ mode: "pat", generation: generation() }));
  await changed();
}

/** The user pasted a token into the bots' GitHub app: that's choosing it. */
export async function choosePat(): Promise<void> {
  const record = await read();
  if (record && record.mode !== "pat") {
    cancelAllFlows();
    await vault.updateJson<GithubRecord>(RECORD, () => ({ mode: "pat", generation: generation() }));
  }
}

/**
 * For a token that may have leaked: delete it here, then ask GitHub to revoke both tokens through
 * its credential revocation API. That API is meant for exposed credentials, takes no authentication
 * and tells the owner about it, so it's a separate, explicit action rather than what disconnecting does.
 */
export async function revokeLeaked(): Promise<void> {
  const record = await read();
  const app = record?.mode === "app" ? record.app : undefined;
  const credentials = [app?.access, app?.refresh].filter((c): c is string => !!c);
  await disconnect();
  if (!credentials.length) throw new GithubError("There's no GitHub App sign-in here to revoke.");
  let res: Response;
  try {
    res = await fetch(`${apiOrigin()}/credentials/revoke`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "OpenBuild", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({ credentials }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    throw new GithubError("Disconnected here, but GitHub couldn't be reached to revoke it. Revoke OpenBuild in your GitHub settings.", 502);
  }
  if (!res.ok) throw new GithubError(`Disconnected here, but GitHub didn't take the revocation (HTTP ${res.status}). Revoke OpenBuild in your GitHub settings.`, 502);
}

// ------------------------------------------------------------------ installations

async function api(path: string, token: string): Promise<Response> {
  return fetch(`${apiOrigin()}${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "OpenBuild", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

interface RawInstallation {
  id: number;
  account?: { login?: string; type?: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
}

/**
 * Where the app is installed that this user can reach: their own account and organizations. GitHub
 * decides this — an organization's owners install it or approve a member's request — and its
 * repository selection is what limits the token, not anything OpenBuild does.
 */
export async function installations(): Promise<GithubInstallation[]> {
  const record = await read();
  if (record?.mode !== "app") return [];
  const token = await appAccess(true);
  if (!token) return [];
  const res = await api("/user/installations?per_page=100", token);
  if (res.status === 401) {
    await signOut(record.generation);
    throw new GithubError("GitHub signed OpenBuild out. Connect again.", 401);
  }
  if (!res.ok) throw new GithubError(`GitHub answered ${res.status} for the installations.`, 502);
  const list = ((await res.json()) as { installations?: RawInstallation[] }).installations ?? [];
  return Promise.all(
    list.map(async (raw) => {
      const base = { id: raw.id, account: raw.account?.login ?? "unknown", accountType: raw.account?.type === "Organization" ? ("Organization" as const) : ("User" as const) };
      const out: GithubInstallation = { ...base, repositorySelection: raw.repository_selection === "selected" ? "selected" : "all", suspended: !!raw.suspended_at, manageUrl: manageUrl(base) };
      if (out.repositorySelection === "selected") {
        const repos = await api(`/user/installations/${raw.id}/repositories?per_page=50`, token);
        if (repos.ok) {
          const body = (await repos.json()) as { total_count?: number; repositories?: { full_name?: string; name?: string; private?: boolean }[] };
          out.repositories = (body.repositories ?? []).map((r) => ({ name: r.full_name ?? r.name ?? "?", private: !!r.private }));
          const more = (body.total_count ?? 0) - out.repositories.length;
          if (more > 0) out.moreRepositories = more;
        }
      }
      return out;
    }),
  );
}

// ------------------------------------------------------------------ the device flow

interface Flow {
  id: string;
  /** Who started it: only that browser can watch or cancel it (see routes.ts). */
  owner: string;
  /** Stays on the server. Cleared once the flow ends. */
  deviceCode: string;
  interval: number;
  expiresAt: number;
  status: DeviceStatus;
  timer?: ReturnType<typeof setTimeout>;
  endedAt?: number;
}

const flows = (kept.openbuildGithubFlows ??= new Map());
/** Finished flows are kept this long so the browser can see how they ended. */
const KEEP_ENDED = 10 * 60_000;

function end(flow: Flow, status: DeviceStatus) {
  if (flow.timer) clearTimeout(flow.timer);
  flow.timer = undefined;
  flow.deviceCode = "";
  flow.status = status;
  flow.endedAt = Date.now();
}

/**
 * Bumped by every new sign-in and every change of credential. A sign-in still waiting for GitHub to
 * hand out its code checks this afterwards, so one started before a disconnect or another sign-in
 * never gets going.
 */
const starts = (kept.openbuildGithubStarts ??= { n: 0 });

function cancelAllFlows() {
  starts.n++;
  for (const flow of flows.values()) if (flow.status.status === "pending") end(flow, { status: "cancelled" });
}

function prune() {
  for (const [id, flow] of flows) if (flow.endedAt && Date.now() - flow.endedAt > KEEP_ENDED) flows.delete(id);
}

export async function startDevice(owner: string): Promise<{ flowId: string; status: DeviceStatus }> {
  const { clientId } = appConfig();
  if (!clientId) throw new GithubError("The GitHub App isn't set up on this server. See docs/github.md.", 503);
  prune();
  // One sign-in at a time: a new one replaces any still waiting, or still starting.
  cancelAllFlows();
  const start = starts.n;
  let body: { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string };
  try {
    const res = await fetch(`${oauthOrigin()}/login/device/code`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    body = (await res.json().catch(() => ({}))) ?? {};
  } catch {
    throw new GithubError("Couldn't reach GitHub.", 502);
  }
  if (body.error === "device_flow_disabled") throw new GithubError("The GitHub App doesn't have device flow turned on. See docs/github.md.", 503);
  if (!body.device_code || !body.user_code || !body.verification_uri) throw new GithubError(body.error ? `GitHub refused to start signing in (${body.error}).` : "GitHub didn't start signing in.", 502);
  // Disconnected, or another sign-in started, while GitHub answered: this one is dropped unused.
  if (start !== starts.n) throw new GithubError("Another sign-in or a disconnect replaced this one.", 409);
  const expiresAt = Date.now() + (body.expires_in ?? 900) * 1000;
  const flow: Flow = {
    id: crypto.randomUUID(),
    owner,
    deviceCode: body.device_code,
    interval: Math.max(0, body.interval ?? 5),
    expiresAt,
    status: { status: "pending", userCode: body.user_code, verificationUri: body.verification_uri, expiresAt },
  };
  flows.set(flow.id, flow);
  schedule(flow);
  return { flowId: flow.id, status: flow.status };
}

function owned(id: string, owner: string): Flow {
  const flow = flows.get(id);
  if (!flow) throw new GithubError("That sign-in isn't here anymore.", 404);
  if (flow.owner !== owner) throw new GithubError("That sign-in was started somewhere else.", 403);
  return flow;
}

export const deviceStatus = (id: string, owner: string): DeviceStatus => owned(id, owner).status;

export function cancelDevice(id: string, owner: string) {
  const flow = owned(id, owner);
  if (flow.status.status === "pending") end(flow, { status: "cancelled" });
}

function schedule(flow: Flow) {
  flow.timer = setTimeout(() => void poll(flow), flow.interval * 1000);
  flow.timer.unref?.();
}

async function poll(flow: Flow) {
  flow.timer = undefined;
  if (flow.status.status !== "pending") return;
  if (Date.now() >= flow.expiresAt) return end(flow, { status: "expired" });
  const { clientId } = appConfig();
  let body: TokenResponse;
  try {
    body = await tokenRequest({ client_id: clientId, device_code: flow.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
  } catch {
    if (flow.status.status === "pending") schedule(flow);
    return;
  }
  if (flow.status.status !== "pending") return;
  if (body.error === "authorization_pending") return schedule(flow);
  if (body.error === "slow_down") {
    flow.interval = typeof body.interval === "number" ? body.interval : flow.interval + 5;
    return schedule(flow);
  }
  if (body.error === "expired_token") return end(flow, { status: "expired" });
  if (body.error === "access_denied") return end(flow, { status: "denied" });
  const tokens = tokensFrom(body);
  if (!tokens) return end(flow, { status: "error", error: body.error ? `GitHub refused the sign-in (${body.error}).` : "GitHub didn't send a token." });

  let user: { login?: string; id?: number };
  try {
    const res = await api("/user", tokens.access);
    if (!res.ok) throw new Error();
    user = (await res.json()) as typeof user;
  } catch {
    return end(flow, { status: "error", error: "GitHub didn't say who signed in. Try again." });
  }
  if (typeof user.login !== "string" || typeof user.id !== "number") return end(flow, { status: "error", error: "GitHub didn't say who signed in. Try again." });

  // Saved only if this sign-in is still the one waiting: a cancel or disconnect while it ran wins.
  let saved = false;
  await vault.updateJson<GithubRecord>(RECORD, (current) => {
    if (flows.get(flow.id) !== flow || flow.status.status !== "pending") return current;
    saved = true;
    return { mode: "app", generation: generation(), app: { ...tokens, login: user.login!, userId: user.id! } };
  });
  if (!saved) return;
  end(flow, { status: "connected", login: user.login });
  await changed();
}
