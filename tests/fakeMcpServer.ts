// A stand-in for a service's remote MCP server and its OAuth: protected resource metadata, an
// authorization server with dynamic registration and PKCE, refresh tokens, and two tools. It also
// answers on /open (no sign-in) and /keyed (a pasted key in a header). Run as a script, it prints its
// address and stays up until killed; tests flip its state through /control.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHash } from "node:crypto";
import { z } from "zod";

const state = {
  access: new Set<string>(),
  refresh: new Set<string>(),
  codes: new Map<string, { challenge: string; redirect: string; clientId: string }>(),
  clients: new Set<string>(),
  issued: 0,
  registered: 0,
};

function mcp(who: string) {
  const server = new McpServer({ name: "fake", version: "1" });
  server.registerTool("echo", { description: "Says the text back.", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
  server.registerTool("whoami", { description: "Says who is calling.", annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: who }] }));
  return server;
}

async function serveMcp(req: Request, who: string) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp(who).connect(transport);
  return transport.handleRequest(req);
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;
    if (url.pathname === "/control") {
      const body = (await req.json()) as { expire?: boolean; revoke?: boolean };
      if (body.expire) state.access.clear();
      if (body.revoke) state.access.clear(), state.refresh.clear();
      return json({ issued: state.issued, registered: state.registered });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register" && req.method === "POST") {
      const body = (await req.json()) as Record<string, unknown>;
      const client_id = `client-${++state.registered}`;
      state.clients.add(client_id);
      return json({ ...body, client_id }, 201);
    }
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (!state.clients.has(p.get("client_id") ?? "") || p.get("code_challenge_method") !== "S256") return json({ error: "invalid_request" }, 400);
      const code = crypto.randomUUID();
      state.codes.set(code, { challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, clientId: p.get("client_id")! });
      const back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state") ?? "");
      return Response.redirect(back.href, 302);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const p = new URLSearchParams(await req.text());
      const issue = () => {
        const access = `access-${++state.issued}`;
        const refresh = `refresh-${state.issued}`;
        state.access.add(access);
        state.refresh.add(refresh);
        return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh });
      };
      if (p.get("grant_type") === "authorization_code") {
        const code = state.codes.get(p.get("code") ?? "");
        state.codes.delete(p.get("code") ?? "");
        const verifier = p.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!code || code.challenge !== challenge || code.redirect !== p.get("redirect_uri") || code.clientId !== p.get("client_id")) return json({ error: "invalid_grant" }, 400);
        return issue();
      }
      if (p.get("grant_type") === "refresh_token") {
        if (!state.refresh.delete(p.get("refresh_token") ?? "")) return json({ error: "invalid_grant" }, 400);
        return issue();
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url.pathname === "/mcp") {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!state.access.has(token)) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"` } });
      return serveMcp(req, token);
    }
    if (url.pathname === "/open") return serveMcp(req, "anyone");
    if (url.pathname === "/keyed") {
      if (req.headers.get("x-api-key") !== "sekrit") return json({ error: "bad key" }, 401);
      return serveMcp(req, "keyed");
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(server.url.origin);
