// The hosted relay's guards: same-site only, keys only from the request, SearXNG only on public https.
import { describe, expect, test } from "bun:test";
import { isPublicUrl } from "../server/handlers";
import chat from "../server/vercel/chat";
import models from "../server/vercel/models";

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
});
