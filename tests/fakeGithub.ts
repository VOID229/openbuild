// A stand-in for GitHub's side of OpenBuild's GitHub App: the device flow, token refresh with
// rotation (no client secret allowed), /user, installations on a personal account and an
// organization, the credential revocation API, and a remote MCP server that only reaches the
// selected repositories. That server lists its write tool even when asked for read-only, so what
// tests check is OpenBuild's own rule. It is a mock: passing against it is not the live gates in docs/github.md.
// Run as a script, it prints its address and stays up until killed; tests drive it through /control.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const CLIENT_ID = "test-client";
/** What the installations reach: octo/sel on the personal account (selected), and every acme repository. */
const reachable = (owner: string, repo: string) => (owner === "octo" && repo === "sel") || owner === "acme";

const state = {
  devices: new Map<string, "pending" | "approved" | "denied" | "used">(),
  access: new Set<string>(),
  refresh: new Set<string>(),
  issued: 0,
  refreshes: 0,
  expiresIn: 28800,
  refreshDelay: 0,
  secretsSeen: 0,
  revoked: [] as string[],
  writes: 0,
  readonlyHeaders: [] as string[],
};

const json = (value: unknown, status = 200) => Response.json(value, { status });

function issue() {
  const n = ++state.issued;
  const access = `ghu_fake${n}`;
  const refresh = `ghr_fake${n}`;
  state.access.add(access);
  state.refresh.add(refresh);
  return { access_token: access, expires_in: state.expiresIn, refresh_token: refresh, refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" };
}

const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
const signedIn = (req: Request) => state.access.has(bearer(req));

function mcp() {
  const server = new McpServer({ name: "fake-github", version: "1" });
  server.registerTool(
    "get_file_contents",
    { description: "Reads a file.", inputSchema: { owner: z.string(), repo: z.string(), path: z.string() }, annotations: { readOnlyHint: true } },
    async ({ owner, repo, path }) => (reachable(owner, repo) ? { content: [{ type: "text", text: `contents of ${owner}/${repo}/${path}` }] } : { isError: true, content: [{ type: "text", text: "404 Not Found" }] }),
  );
  server.registerTool("create_issue", { description: "Opens an issue.", inputSchema: { owner: z.string(), repo: z.string(), title: z.string() } }, async () => {
    state.writes++;
    return { content: [{ type: "text", text: "created" }] };
  });
  return server;
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;

    if (url.pathname === "/control") {
      if (req.method === "POST") {
        const body = (await req.json()) as { approve?: string; deny?: string; expiresIn?: number; refreshDelay?: number; dropRefresh?: boolean };
        if (body.approve) state.devices.set(body.approve, "approved");
        if (body.deny) state.devices.set(body.deny, "denied");
        if (body.expiresIn !== undefined) state.expiresIn = body.expiresIn;
        if (body.refreshDelay !== undefined) state.refreshDelay = body.refreshDelay;
        if (body.dropRefresh) state.refresh.clear();
      }
      return json({ ...state, devices: Object.fromEntries(state.devices), access: [...state.access], refresh: [...state.refresh] });
    }

    if (url.pathname === "/login/device/code" && req.method === "POST") {
      const body = (await req.json()) as Record<string, string>;
      if (body.client_id !== CLIENT_ID) return json({ error: "incorrect_client_credentials" });
      const code = `device-${state.devices.size + 1}`;
      state.devices.set(code, "pending");
      return json({ device_code: code, user_code: `CODE-${state.devices.size}`, verification_uri: `${origin}/login/device`, expires_in: 900, interval: 0 });
    }

    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      const body = (await req.json()) as Record<string, string>;
      if (body.client_secret !== undefined) state.secretsSeen++;
      if (body.client_id !== CLIENT_ID || body.client_secret !== undefined) return json({ error: "incorrect_client_credentials" });
      if (body.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        const status = state.devices.get(body.device_code ?? "");
        if (!status) return json({ error: "incorrect_device_code" });
        if (status === "pending") return json({ error: "authorization_pending" });
        if (status === "denied") return json({ error: "access_denied" });
        if (status === "used") return json({ error: "expired_token" });
        state.devices.set(body.device_code!, "used");
        return json(issue());
      }
      if (body.grant_type === "refresh_token") {
        state.refreshes++;
        if (state.refreshDelay) await Bun.sleep(state.refreshDelay);
        if (!state.refresh.has(body.refresh_token ?? "")) return json({ error: "bad_refresh_token" });
        // Rotation: the refresh token and the access token issued with it both stop working.
        state.refresh.delete(body.refresh_token!);
        state.access.delete(body.refresh_token!.replace("ghr_", "ghu_"));
        return json(issue());
      }
      return json({ error: "unsupported_grant_type" });
    }

    if (url.pathname === "/credentials/revoke" && req.method === "POST") {
      if (req.headers.get("authorization")) return json({ message: "Authenticated requests are refused" }, 403);
      const { credentials } = (await req.json()) as { credentials: string[] };
      for (const c of credentials) {
        state.revoked.push(c);
        state.access.delete(c);
        state.refresh.delete(c);
      }
      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/user") return signedIn(req) ? json({ login: "octo", id: 42 }) : json({ message: "Bad credentials" }, 401);
    if (url.pathname === "/user/installations") {
      if (!signedIn(req)) return json({ message: "Bad credentials" }, 401);
      return json({
        total_count: 2,
        installations: [
          { id: 11, account: { login: "octo", type: "User" }, repository_selection: "selected", suspended_at: null },
          { id: 22, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null },
        ],
      });
    }
    if (url.pathname === "/user/installations/11/repositories") {
      if (!signedIn(req)) return json({ message: "Bad credentials" }, 401);
      return json({ total_count: 1, repositories: [{ full_name: "octo/sel", private: true }] });
    }

    if (url.pathname === "/mcp") {
      if (!signedIn(req)) return json({ error: "unauthorized" }, 401);
      state.readonlyHeaders.push(req.headers.get("x-mcp-readonly") ?? "");
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp().connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(server.url.origin);
