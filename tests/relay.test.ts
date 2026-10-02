// The hosted relay's guards: same-site only, keys only from the request, SearXNG only on public https.
import { describe, expect, test } from "bun:test";
import { isPublicUrl } from "../server/handlers";
import chat from "../server/vercel/chat";
import models from "../server/vercel/models";
import verifySearch from "../server/vercel/verify-search";
import { checkSearch } from "../server/search";

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://openchat.shade-io.com${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("hosted relay", () => {
  test("rejects other websites", async () => {
    expect((await chat(post("/api/chat", {}, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await models(post("/api/models", {}, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await chat(post("/api/chat", {}, { origin: "https://openchat.shade-io.com" }))).status).toBe(400);
  });

  test("needs keys in the request and keeps none", async () => {
    const msg = { plan: "go", model: "x", messages: [{ role: "user", content: "hi" }] };
    expect((await (await chat(post("/api/chat", msg))).json()).error).toBe("Malformed chat request");
    expect((await (await chat(post("/api/chat", { ...msg, secrets: {} }))).json()).error).toMatch(/No Opencode Go API key/);
    expect((await chat(post("/api/chat", { ...msg, secrets: { go: ["x".repeat(600)] } }))).status).toBe(400);
    expect((await models(post("/api/models", { plan: "go" }))).status).toBe(404);
  });

  test("SearXNG must be a public https address", () => {
    for (const ok of ["https://search.example.org", "https://searx.be/", "https://1.1.1.1"]) expect(isPublicUrl(ok)).toBe(true);
    for (const bad of [
      "http://search.example.org",
      "https://localhost:8080",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://192.168.1.10:8080",
      "https://172.20.1.1",
      "https://169.254.169.254/latest/meta-data",
      "https://100.100.1.1",
      "https://[::1]",
      "https://[fd00::1]",
      "https://nas.local",
      "https://intranet",
      "not a url",
    ])
      expect(isPublicUrl(bad)).toBe(false);
  });

  test("search checks: same-site only, SearXNG only on public https", async () => {
    expect((await verifySearch(post("/api/verify-search", { provider: "exa", key: "k" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await verifySearch(post("/api/verify-search", { provider: "nope", key: "k" }))).status).toBe(400);
    expect((await verifySearch(post("/api/verify-search", { provider: "exa" }))).status).toBe(404);
    const res = await (await verifySearch(post("/api/verify-search", { provider: "searxng", url: "http://192.168.1.10:8080" }))).json();
    expect(res.status).toBe("invalid");
  });
});

describe("search check", () => {
  test("SearXNG: works, JSON disabled, unreachable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/ok/search") return Response.json({ results: [{ title: "t", url: "https://example.com", content: "c" }] });
        if (url.pathname === "/nojson/search") return new Response("Forbidden", { status: 403 });
        return new Response("<html></html>");
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await checkSearch("searxng", `${base}/ok`)).status).toBe("valid");
      const nojson = await checkSearch("searxng", `${base}/nojson`);
      expect(nojson.status).toBe("error");
      expect(nojson.error).toMatch(/search\.formats/);
      expect((await checkSearch("searxng", `${base}/html`)).error).toMatch(/isn't JSON/);
    } finally {
      server.stop(true);
    }
    expect((await checkSearch("searxng", "http://127.0.0.1:1")).error).toMatch(/Couldn't reach SearXNG/);
  });
});
