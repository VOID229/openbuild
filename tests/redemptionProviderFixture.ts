// Executed only in a disposable subprocess: module mocks cannot leak into other tests.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = await mkdtemp(join(tmpdir(), "redemption-provider-"));
process.env.HOME = root;
process.env.OPENCHAT_DATA_DIR = join(root, "data");
process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
process.env.CODEX_HOME = join(root, ".codex");
const op = "provider_operation_0001";
const nextOp = "provider_operation_0002";
let codexCalls: unknown[] = [];
let loseCodex = true;
mock.module("../server/pi/install", () => ({ agentDir: () => join(root, "pi") }));
mock.module("../server/codex/install", () => ({ codexEnv: () => ({}) }));
mock.module("../server/codex/rpc", () => ({ CodexProcess: class {
  async initialize() {}
  async request(method: string, params: unknown) {
    assert.equal(method, "account/rateLimitResetCredit/consume");
    codexCalls.push(params);
    if (loseCodex) { loseCodex = false; throw new Error("lost codex response"); }
    return { outcome: "alreadyRedeemed" };
  }
  close() {}
} }));
// No real CLI is ever located or launched.
Bun.which = (() => "/fake/claude") as typeof Bun.which;
Bun.spawn = (() => ({ stdout: new Blob(["2.1.99"]).stream(), exited: Promise.resolve(0), kill() {} })) as any;
let gets = 0;
const posts: any[] = [];
let mode: "503" | "lost" | "ok" = "503";
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const address = String(url);
  if (address.includes("/api/oauth/usage?")) {
    assert.equal(init?.method ?? "GET", "GET");
    gets++;
    return Response.json({ cedar_ember: { eligible: true, next_grant_id: `grant-${gets}`, grants: [{ id: `grant-${gets}`, usable_now: true, resets_left: 1 }] } });
  }
  if (address === "https://api.anthropic.com/api/organizations/org/reset_rate_limits") {
    posts.push(JSON.parse(String(init?.body)));
    if (mode === "503") return new Response("", { status: 503 });
    if (mode === "lost") throw new Error("lost after spend");
    return Response.json({ result: "already_used" });
  }
  throw new Error(`LIVE NETWORK FORBIDDEN: ${address}`);
}) as typeof fetch;
try {
  await mkdir(join(root, ".claude"), { recursive: true });
  await mkdir(join(root, ".codex"), { recursive: true });
  await mkdir(process.env.OPENCHAT_DATA_DIR, { recursive: true });
  await writeFile(join(process.env.OPENCHAT_DATA_DIR, "usage-remote.json"), JSON.stringify({ "paired|limits": { at: Date.now(), value: { providers: [{ id: "fake", resetCredits: 5 }] } } }));
  await writeFile(join(root, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake" } }));
  await writeFile(join(root, ".claude", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "fake-account", organizationUuid: "org" } }));
  await writeFile(join(root, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "fake", account_id: "fake-codex" } }));
  const { resetCredit } = await import("../server/usage/limits");
  await assert.rejects(resetCredit("claude:fake-account", op), /503/);
  await assert.rejects(resetCredit("claude:fake-account", nextOp), /earlier reset/);
  mode = "lost";
  await assert.rejects(resetCredit("claude:fake-account", op), /lost after spend/);
  mode = "ok";
  assert.deepEqual(await resetCredit("claude:fake-account", op), { outcome: "alreadyRedeemed" });
  assert.deepEqual(await resetCredit("claude:fake-account", op), { outcome: "alreadyRedeemed" });
  assert.equal(gets, 1); // no new grant selection, no redundant limits refresh
  assert.equal(posts.length, 3);
  assert.ok(posts.every(p => p.grant_id === "grant-1" && p.request_id === op));
  await assert.rejects(resetCredit("codex:acct:fake-codex", op), /lost codex response/);
  await assert.rejects(resetCredit("codex:acct:fake-codex", nextOp), /earlier reset/);
  assert.deepEqual(await resetCredit("codex:acct:fake-codex", op), { outcome: "alreadyRedeemed" });
  await resetCredit("codex:acct:fake-codex", op);
  assert.deepEqual(codexCalls, [{ idempotencyKey: op }, { idempotencyKey: op }]);

  mock.module("../server/devices", () => ({ readDevices: () => [{ id: "paired", name: "Fake", urls: ["https://paired.invalid"], token: "fake" }], touchDevice() {}, deviceName: () => "Fake local" }));
  mock.module("../server/usage/report", () => ({ report: () => { throw new Error("REPORT ACCESS FORBIDDEN"); } }));
  mock.module("../server/handlers", () => ({ readJson: (req: Request) => req.json(), bad: (error: string) => Response.json({ error }, { status: 400 }) }));
  let forwarded: any;
  let supportsIdentity = false;
  let pairedPosts = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(url, "https://paired.invalid/api/usage/limits/reset?scope=local");
    if ((init.method ?? "GET") === "GET") return Response.json(supportsIdentity ? { durableOperationIdentity: 1 } : {});
    pairedPosts++;
    forwarded = JSON.parse(init.body);
    return Response.json({ outcome: "alreadyRedeemed" });
  }) as typeof fetch;
  const { usageRoutes } = await import("../server/usage/routes");
  const routes = usageRoutes(handler => handler);
  const request = (body: unknown, scope = "") => new Request(`https://local.invalid/api/usage/limits/reset${scope}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  assert.equal((await routes["/api/usage/limits/reset"].POST(request({ id: "fake" }))).status, 400);
  const unsupported = await routes["/api/usage/limits/reset"].POST(request({ id: "fake", machine: "paired", operationId: op }));
  assert.equal(unsupported.status, 500);
  assert.equal(pairedPosts, 0);
  supportsIdentity = true;
  const response = await routes["/api/usage/limits/reset"].POST(request({ id: "fake", machine: "paired", operationId: op }));
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded, { id: "fake", operationId: op });
  await rm(join(root, ".claude", ".credentials.json")); // completed replay must not require sign-in access
  const local = await routes["/api/usage/limits/reset"].POST(request({ id: "claude:fake-account", operationId: op }, "?scope=local"));
  assert.deepEqual(await local.json(), { outcome: "alreadyRedeemed" });
  await Bun.sleep(1100);
  const remoteCache = JSON.parse(await readFile(join(process.env.OPENCHAT_DATA_DIR, "usage-remote.json"), "utf8"));
  assert.equal(remoteCache["paired|limits"], undefined);
  console.log("isolated provider and route checks passed");
} finally { await Bun.sleep(1100); await rm(root, { recursive: true, force: true }); }
