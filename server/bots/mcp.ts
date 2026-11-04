// The MCP side of OpenBots' apps: signing in to a service (OAuth with discovery, self-registration
// or the user's own OAuth app, and PKCE), and a pool of live MCP connections that bots' tool calls go
// through. Sign-ins live in the vault under `app:<id>`; the user's own OAuth apps under
// `app-client:<service>`. Nothing here reaches a bot: it gets tool results, never a token.
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { appUrl, fillTemplate, type CatalogApp, type OAuthClientId } from "../../shared/apps";
import * as vault from "../vault";

/** What the vault keeps for an app. */
export interface AppSecrets {
  tokens?: OAuthTokens;
  /** A client the service registered for us, and the redirect URI it was registered with. */
  client?: OAuthClientInformationMixed & { redirect?: string };
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  /** Keys the user pasted. */
  fields?: Record<string, string>;
}

/** An OAuth app the user registered with a service themselves. */
export interface OwnClient {
  id: string;
  secret?: string;
}

export const secretsName = (appId: string) => `app:${appId}`;
export const clientName = (id: OAuthClientId) => `app-client:${id}`;

export const getSecrets = async (appId: string) => (await vault.getJson<AppSecrets>(secretsName(appId))) ?? {};
export const saveSecrets = (appId: string, change: (s: AppSecrets) => AppSecrets | undefined) => vault.updateJson<AppSecrets>(secretsName(appId), (s) => change(s ?? {}));
export const getOwnClient = (id: OAuthClientId) => vault.getJson<OwnClient>(clientName(id));
export const saveOwnClient = (id: OAuthClientId, client: OwnClient | undefined) => vault.updateJson<OwnClient>(clientName(id), () => client);

/** A sign-in that needs the user: the token is gone or refused. */
export class NeedsSignIn extends Error {}

/**
 * The SDK's OAuth client for one app. `onAuthorize` is set while the user is connecting, and gets the
 * page to send them to; without it (a bot's tool call) a sign-in that needs the user fails instead.
 */
export class AppAuth implements OAuthClientProvider {
  private pendingVerifier?: string;
  constructor(
    private readonly app: CatalogApp,
    private readonly redirect: string | undefined,
    private readonly own: OwnClient | undefined,
    private readonly flowState?: string,
    private readonly onAuthorize?: (url: URL) => void,
  ) {}

  get redirectUrl() {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "OpenBuild",
      client_uri: "https://github.com/VOID229/openbuild",
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    return this.flowState ?? crypto.randomUUID();
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.app.connection.kind === "client") return this.own ? { client_id: this.own.id, ...(this.own.secret ? { client_secret: this.own.secret } : {}) } : undefined;
    const { client } = await getSecrets(this.app.id);
    // A registration is tied to its redirect URI. Reached at another address, register again.
    if (!client || (this.onAuthorize && client.redirect !== this.redirect)) return undefined;
    const { redirect: _, ...info } = client;
    return info;
  }

  async saveClientInformation(info: OAuthClientInformationMixed) {
    await saveSecrets(this.app.id, (s) => ({ ...s, client: { ...info, redirect: this.redirect } }));
  }

  async tokens() {
    return (await getSecrets(this.app.id)).tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    // A refresh can come back without a refresh token, meaning the old one still stands.
    await saveSecrets(this.app.id, (s) => ({ ...s, tokens: { ...tokens, refresh_token: tokens.refresh_token ?? s.tokens?.refresh_token } }));
  }

  redirectToAuthorization(url: URL) {
    // Google only hands out a refresh token for offline access, and again only when asked to consent.
    if (this.app.connection.kind === "client" && this.app.connection.client === "google") {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
    }
    this.onAuthorize?.(url);
  }

  async saveCodeVerifier(verifier: string) {
    if (!this.onAuthorize) return;
    this.pendingVerifier = verifier;
    await saveSecrets(this.app.id, (s) => ({ ...s, verifier }));
  }

  async codeVerifier() {
    const verifier = this.pendingVerifier ?? (await getSecrets(this.app.id)).verifier;
    if (!verifier) throw new NeedsSignIn("The sign-in expired. Connect again.");
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    await saveSecrets(this.app.id, (s) => {
      if (scope === "all") return { fields: s.fields };
      const next = { ...s };
      if (scope === "client") delete next.client;
      if (scope === "tokens") delete next.tokens;
      if (scope === "verifier") delete next.verifier;
      if (scope === "discovery") delete next.discovery;
      return next;
    });
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    await saveSecrets(this.app.id, (s) => ({ ...s, discovery }));
  }

  async discoveryState() {
    return (await getSecrets(this.app.id)).discovery;
  }
}

const TIMEOUT = 30_000;

/** What a server says when asked without a token: where its sign-in is described, and the scope it wants. */
async function challenge(url: string): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenBuild", version: "1" } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    void res.body?.cancel().catch(() => {});
    return res.status === 401 ? extractWWWAuthenticateParams(res) : {};
  } catch {
    return {};
  }
}

/** Start signing in: the page to send the user to. */
export async function beginSignIn(app: CatalogApp, values: Record<string, string>, redirect: string, state: string, own?: OwnClient): Promise<string> {
  const url = appUrl(app, values)!;
  let page: URL | undefined;
  const provider = new AppAuth(app, redirect, own, state, (u) => (page = u));
  // A fresh sign-in: the old tokens and discovery go, a registration for this address stays.
  await saveSecrets(app.id, (s) => ({ client: s.client, fields: s.fields }));
  const asked = await challenge(url);
  const scopes = "scopes" in app.connection ? app.connection.scopes : undefined;
  const result = await auth(provider, { serverUrl: url, scope: scopes?.join(" ") || asked.scope, resourceMetadataUrl: asked.resourceMetadataUrl });
  if (result === "AUTHORIZED" || !page) throw new Error(`${app.name} didn't ask to sign in.`);
  return page.href;
}

/** Finish signing in with the code the service sent back. */
export async function finishSignIn(app: CatalogApp, values: Record<string, string>, redirect: string, code: string, own?: OwnClient) {
  const provider = new AppAuth(app, redirect, own, undefined, () => {});
  const result = await auth(provider, { serverUrl: appUrl(app, values)!, authorizationCode: code });
  if (result !== "AUTHORIZED") throw new Error(`${app.name} didn't accept the sign-in.`);
  await saveSecrets(app.id, (s) => ({ ...s, verifier: undefined }));
}

// ------------------------------------------------------------------ connections

interface Live {
  client: Client;
  key: string;
  usedAt: number;
}

const kept = globalThis as { openbotsMcp?: Map<string, Promise<Live>>; openbotsMcpTimer?: ReturnType<typeof setInterval> };
const pool = (kept.openbotsMcp ??= new Map());
const IDLE = 10 * 60_000;

/** How an app is reached right now. A change (new keys, another site) means a new connection. */
interface Target {
  app: CatalogApp;
  values: Record<string, string>;
  secrets: AppSecrets;
  own?: OwnClient;
}

const targetKey = ({ app, values, secrets, own }: Target) => JSON.stringify([app.connection, values, secrets.fields, secrets.client?.client_id, own?.id]);

function headersFor({ app, values, secrets }: Target): Record<string, string> {
  if (app.connection.kind !== "token") return {};
  const all = { ...values, ...secrets.fields };
  return Object.fromEntries(Object.entries(app.connection.headers).map(([name, template]) => [name, fillTemplate(template, app, all)]));
}

function transports(target: Target): (() => Transport)[] {
  const { app } = target;
  const c = app.connection;
  if (c.kind === "local") {
    return [
      () =>
        new StdioClientTransport({
          command: c.command,
          args: c.args,
          // The default environment is a short allowlist; programs like npx and op need the real PATH.
          env: { ...getDefaultEnvironment(), PATH: process.env.PATH ?? "" },
          stderr: "pipe",
        }),
    ];
  }
  const url = new URL(appUrl(app, target.values)!);
  const signedIn = c.kind === "oauth" || c.kind === "client";
  const authProvider = signedIn ? new AppAuth(app, target.secrets.client?.redirect, target.own) : undefined;
  const requestInit = { headers: headersFor(target) };
  return [() => new StreamableHTTPClientTransport(url, { authProvider, requestInit }), () => new SSEClientTransport(url, { authProvider, requestInit })];
}

const isAuthError = (err: unknown) => err instanceof NeedsSignIn || (err instanceof Error && (err.name === "UnauthorizedError" || /\b401\b|unauthori[sz]ed|invalid_token|invalid_grant/i.test(err.message)));

async function open(target: Target): Promise<Live> {
  const { app } = target;
  if (app.connection.kind === "local" && !Bun.which(app.connection.command)) throw new Error(`${app.connection.command} isn't installed here. ${app.connection.install}`);
  let last: unknown;
  for (const make of transports(target)) {
    const client = new Client({ name: "OpenBuild", version: "1" }, { capabilities: {} });
    try {
      await client.connect(make(), { timeout: app.connection.kind === "local" ? 180_000 : TIMEOUT });
      return { client, key: targetKey(target), usedAt: Date.now() };
    } catch (err) {
      last = err;
      void client.close().catch(() => {});
      // Signing in or a refused key won't go better over the older transport.
      if (isAuthError(err)) throw new NeedsSignIn(`${app.name} needs you to sign in again.`);
    }
  }
  if (app.connection.kind === "desktop") throw new Error(`Couldn't reach ${app.name} on this computer. ${app.connection.install}`);
  throw last instanceof Error ? last : new Error(String(last));
}

async function live(target: Target): Promise<Live> {
  const key = targetKey(target);
  const existing = pool.get(target.app.id);
  if (existing) {
    const got = await existing.catch(() => undefined);
    if (got && got.key === key) return got;
    pool.delete(target.app.id);
    void got?.client.close().catch(() => {});
  }
  const next = open(target);
  pool.set(target.app.id, next);
  next.catch(() => pool.get(target.app.id) === next && pool.delete(target.app.id));
  return next;
}

/** Run something on an app's connection, reconnecting once if the old one went away. */
export async function withClient<T>(target: Target, run: (client: Client) => Promise<T>): Promise<T> {
  ensureSweep();
  for (let attempt = 0; ; attempt++) {
    const l = await live(target);
    l.usedAt = Date.now();
    try {
      return await run(l.client);
    } catch (err) {
      if (isAuthError(err)) {
        await close(target.app.id);
        throw new NeedsSignIn(`${target.app.name} needs you to sign in again.`);
      }
      // A dropped connection (a restarted program, a server that forgot the session) gets one retry.
      const gone = /closed|not connected|session|ECONNRESET|terminated|404/i.test(err instanceof Error ? err.message : String(err));
      if (!gone || attempt > 0) throw err;
      await close(target.app.id);
    }
  }
}

export async function close(appId: string) {
  const existing = pool.get(appId);
  pool.delete(appId);
  const got = await existing?.catch(() => undefined);
  await got?.client.close().catch(() => {});
}

function ensureSweep() {
  if (kept.openbotsMcpTimer) return;
  kept.openbotsMcpTimer = setInterval(async () => {
    for (const [id, p] of pool) {
      const got = await p.catch(() => undefined);
      if (got && Date.now() - got.usedAt > IDLE) void close(id);
    }
  }, 60_000);
  kept.openbotsMcpTimer.unref?.();
}

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  readOnly?: boolean;
}

export async function listTools(target: Target): Promise<ToolInfo[]> {
  return withClient(target, async (client) => {
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: TIMEOUT });
      for (const t of page.tools) {
        tools.push({ name: t.name, title: t.title ?? t.annotations?.title, description: t.description?.slice(0, 4000), inputSchema: t.inputSchema, readOnly: t.annotations?.readOnlyHint });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  });
}

export interface ToolOutput {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

const MAX_TEXT = 60_000;

export function renderResult(result: Record<string, unknown>): ToolOutput {
  const parts: string[] = [];
  const images: ToolOutput["images"] = [];
  const content = Array.isArray(result.content) ? (result.content as Record<string, any>[]) : [];
  for (const c of content) {
    if (c.type === "text") parts.push(String(c.text ?? ""));
    else if (c.type === "image" && typeof c.data === "string" && images.length < 4 && c.data.length < 7_000_000) images.push({ data: c.data, mimeType: String(c.mimeType ?? "image/png") });
    else if (c.type === "resource") parts.push(typeof c.resource?.text === "string" ? c.resource.text : `[${c.resource?.mimeType ?? "file"} at ${c.resource?.uri ?? "?"}]`);
    else if (c.type === "resource_link") parts.push(`[${c.name ?? "link"}](${c.uri})${c.description ? `: ${c.description}` : ""}`);
    else if (c.type === "audio") parts.push(`[audio, ${c.mimeType ?? "unknown type"}]`);
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  if (!parts.length && "toolResult" in result) parts.push(JSON.stringify(result.toolResult, null, 2));
  let text = parts.join("\n\n").trim();
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n\n[Cut short: ${text.length - MAX_TEXT} more characters. Ask for less, or page through it.]`;
  return { text: text || (images.length ? "" : "(no output)"), images, isError: result.isError === true };
}

export async function callTool(target: Target, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  return withClient(target, async (client) => renderResult((await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000, resetTimeoutOnProgress: true })) as Record<string, unknown>));
}
