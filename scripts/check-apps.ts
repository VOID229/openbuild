// Checks OpenBots' app catalog against the real services: each server answers, its sign-in can be
// discovered (and, with --register, a client can register itself), each pinned skill source holds
// skills, and each app has a logo. Run it when the catalog changes: bun scripts/check-apps.ts [--register] [app…]
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, extractWWWAuthenticateParams, registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_CATALOG, appUrl, type CatalogApp } from "../shared/apps";

const args = process.argv.slice(2);
const register = args.includes("--register");
const only = args.filter((a) => !a.startsWith("--"));
const TIMEOUT = 25_000;
const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenBuild", version: "1" } } });

const githubToken = process.env.GITHUB_TOKEN || Bun.spawnSync(["gh", "auth", "token"], { stderr: "ignore" }).stdout.toString().trim();

async function ask(url: string) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: INITIALIZE, signal: AbortSignal.timeout(TIMEOUT) });
}

/** Asked without a token, the server should say so; an OAuth one should also lead to its sign-in. */
async function checkSignIn(app: CatalogApp, url: string): Promise<string> {
  const res = await ask(url);
  void res.body?.cancel().catch(() => {});
  // Google's servers answer the handshake openly and only refuse real tool calls, so its answer here says nothing.
  const google = app.connection.kind === "client" && app.connection.client === "google";
  if (res.status !== 401 && res.status !== 403 && !(google && res.ok)) throw new Error(`answered ${res.status} without a token`);
  if (app.connection.kind === "token") return `refuses without a key (${res.status})`;
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(res);
  let issuer: string | URL = new URL("/", url);
  try {
    const resource = await discoverOAuthProtectedResourceMetadata(url, resourceMetadataUrl ? { resourceMetadataUrl } : undefined);
    if (resource.authorization_servers?.[0]) issuer = resource.authorization_servers[0];
  } catch {
    // Older servers skip resource metadata and describe their sign-in at their own root.
  }
  const metadata = await discoverAuthorizationServerMetadata(issuer);
  if (!metadata) throw new Error(`no sign-in metadata at ${issuer}`);
  if (app.connection.kind === "client") return `sign-in at ${new URL(metadata.authorization_endpoint).host} (own OAuth client)`;
  if (!metadata.registration_endpoint) throw new Error("can't self-register: no registration endpoint");
  if (register) {
    await registerClient(issuer, {
      metadata,
      clientMetadata: { client_name: "OpenBuild", client_uri: "https://github.com/VOID229/openbuild", redirect_uris: ["http://localhost:3000/api/bots/apps/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    });
    return `registered with ${new URL(metadata.registration_endpoint).host}`;
  }
  return `can register at ${new URL(metadata.registration_endpoint).host}`;
}

async function checkOpen(url: string): Promise<string> {
  const client = new Client({ name: "OpenBuild", version: "1" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: TIMEOUT });
    const { tools } = await client.listTools(undefined, { timeout: TIMEOUT });
    if (!tools.length) throw new Error("lists no tools");
    return `${tools.length} tools, no sign-in`;
  } finally {
    await client.close().catch(() => {});
  }
}

async function checkSkills(app: CatalogApp): Promise<string> {
  let total = 0;
  for (const { repo, ref, dir } of app.skills ?? []) {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { headers: { accept: "application/vnd.github+json", "user-agent": "OpenBuild", ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}) }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`${repo}@${ref.slice(0, 7)}: GitHub answered ${res.status}`);
    const { tree } = (await res.json()) as { tree: { path: string }[] };
    const base = dir ? `${dir}/` : "";
    const found = tree.filter((t) => t.path.startsWith(base) && t.path.slice(base.length).split("/").length === 2 && t.path.endsWith("/SKILL.md")).length;
    if (!found) throw new Error(`${repo}@${ref.slice(0, 7)}: no skills in ${dir || "the root"}`);
    total += found;
  }
  return `${total} skills`;
}

async function checkApp(app: CatalogApp): Promise<string[]> {
  const notes: string[] = [];
  const c = app.connection;
  if (c.kind === "open") notes.push(await checkOpen(appUrl(app)!));
  else if (c.kind === "oauth" || c.kind === "client" || c.kind === "token") notes.push(await checkSignIn(app, appUrl(app)!));
  else notes.push(`${c.kind}: runs on this computer, not checked here`);
  if (app.skills?.length) notes.push(await checkSkills(app));
  if (!["svg", "png"].some((ext) => existsSync(join(import.meta.dir, "..", "server", "bots", "logos", `${app.id}.${ext}`)))) throw new Error("no logo");
  return notes;
}

const apps = APP_CATALOG.filter((a) => !only.length || only.includes(a.id));
const failed: string[] = [];
// A few at a time: services answer slowly when a whole catalog arrives at once.
for (let i = 0; i < apps.length; i += 6) {
  await Promise.all(
    apps.slice(i, i + 6).map(async (app) => {
      try {
        console.log(`ok    ${app.id}: ${(await checkApp(app)).join("; ")}`);
      } catch (err) {
        failed.push(app.id);
        console.log(`FAIL  ${app.id}: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );
}
console.log(`\n${apps.length - failed.length}/${apps.length} ok${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
