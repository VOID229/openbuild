import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_CATALOG, APP_CATEGORIES, appReturnOrigin, appUrl, fillTemplate, OAUTH_CLIENTS } from "../shared/apps";
import { frontMatter } from "../server/bots/skills";
import { renderResult } from "../server/bots/mcp";

test("every catalog entry is complete and points at the publisher over https", () => {
  const ids = new Set<string>();
  const categories = new Set(APP_CATEGORIES.map((c) => c.id));
  for (const app of APP_CATALOG) {
    expect(ids.has(app.id)).toBe(false);
    ids.add(app.id);
    expect(app.id).toMatch(/^[a-z0-9-]+$/);
    expect(categories.has(app.category)).toBe(true);
    expect(app.docs).toStartWith("https://");
    expect(["svg", "png"].some((ext) => existsSync(join(import.meta.dir, "..", "server", "bots", "logos", `${app.id}.${ext}`)))).toBe(true);
    const c = app.connection;
    if (c.kind === "client") expect(OAUTH_CLIENTS[c.client]).toBeDefined();
    if (c.kind === "desktop") expect(c.url).toStartWith("http://127.0.0.1:");
    else if ("url" in c) expect(c.url).toStartWith("https://");
    for (const skill of app.skills ?? []) expect(skill.ref).toMatch(/^[0-9a-f]{40}$/);
  }
});

test("the services asked for by name are in the catalog", () => {
  const ids = APP_CATALOG.map((a) => a.id);
  for (const id of ["github", "1password", "gmail", "google-drive", "google-calendar", "microsoft-365", "azure", "vercel", "cloudflare", "notion", "canva", "linear", "slack", "figma", "sentry", "posthog"]) expect(ids).toContain(id);
});

test("templates take field values, then a choice's default", () => {
  const datadog = APP_CATALOG.find((a) => a.id === "datadog")!;
  expect(appUrl(datadog)).toBe("https://mcp.datadoghq.com/v1/mcp");
  expect(appUrl(datadog, { site: "datadoghq.eu" })).toBe("https://mcp.datadoghq.eu/v1/mcp");
  expect(fillTemplate("Bearer {token}", { fields: [{ id: "token", label: "Key" }] }, { token: "abc" })).toBe("Bearer abc");
});

test("only a localhost-only service changes where a sign-in comes back to", () => {
  const vercel = APP_CATALOG.find((a) => a.id === "vercel")!;
  expect(appReturnOrigin(vercel, "http://box.tail0.ts.net:4000")).toBe("http://localhost:4000");
  expect(appReturnOrigin(vercel, "https://box.tail0.ts.net")).toBe("http://localhost:3100");
  expect(appReturnOrigin(vercel, "http://localhost:4000")).toBe("http://localhost:4000");
  expect(appReturnOrigin(vercel, "http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
  const github = APP_CATALOG.find((a) => a.connection.kind === "oauth" && !a.connection.localhostOnly)!;
  expect(appReturnOrigin(github, "https://box.tail0.ts.net")).toBe("https://box.tail0.ts.net");
});

test("skill front matter handles quotes and folded blocks", () => {
  expect(frontMatter(`---\nname: "a"\ndescription: >-\n  one\n  two\nother: x\n---\nbody`)).toEqual({ name: "a", description: "one two" });
  expect(frontMatter("no front matter")).toEqual({});
});

test("tool results become text and images, cut down to size", () => {
  expect(renderResult({ content: [{ type: "text", text: "hi" }, { type: "image", data: "AA", mimeType: "image/png" }] })).toEqual({ text: "hi", images: [{ data: "AA", mimeType: "image/png" }], isError: false });
  expect(renderResult({ isError: true, content: [] })).toEqual({ text: "(no output)", images: [], isError: true });
  expect(renderResult({ structuredContent: { a: 1 } }).text).toContain('"a": 1');
  expect(renderResult({ content: [{ type: "text", text: "x".repeat(70_000) }] }).text).toContain("Cut short");
});

test("an app connects, works, refreshes, signs out and disconnects against a real OAuth and MCP server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbots-apps-"));
  const fake = Bun.spawn([process.execPath, join(import.meta.dir, "fakeMcpServer.ts")], { stdout: "pipe", stderr: "inherit" });
  try {
    const { value } = await fake.stdout.getReader().read();
    const origin = new TextDecoder().decode(value).trim();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        const { default: assert } = await import("node:assert/strict");
        const apps = await import("./server/bots/apps.ts");
        const vault = await import("./server/vault.ts");
        const svc = await import("./server/bots/service.ts");
        const db = await import("./server/bots/db.ts");
        const origin = process.env.FAKE;
        const control = (body) => fetch(origin + "/control", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
        const base = { by: "Test", description: "A test.", category: "code", docs: "https://example.com" };
        apps.addAppForTests({ ...base, id: "fake", name: "Fake", connection: { kind: "oauth", url: origin + "/mcp" }, recommended: true });
        apps.addAppForTests({ ...base, id: "fake-open", name: "Open", connection: { kind: "open", url: origin + "/open" } });
        apps.addAppForTests({ ...base, id: "fake-keyed", name: "Keyed", connection: { kind: "token", url: origin + "/keyed", headers: { "x-api-key": "{key}" } }, fields: [{ id: "key", label: "Key", secret: true }] });

        const signIn = async () => {
          const { authorize } = await apps.connect("fake", { origin: "http://localhost:9" });
          const back = await fetch(authorize, { redirect: "manual" });
          return new URL(back.headers.get("location")).searchParams;
        };

        // Not connected yet: a bot gets told how to offer it. The catalog stays out of its context, behind apps list.
        await assert.rejects(apps.useApp({ app: "fake", tool: "whoami" }), /isn't connected/);
        assert.doesNotMatch(apps.contextNote(), /Fake|Not connected:/);
        assert.match(apps.contextNote(), /No apps are connected yet/);
        assert.match(apps.contextNote(), /apps action list shows .* the apps that aren't connected; .*action connect/);
        assert.ok((await apps.appsTool({ action: "list" })).not_connected.includes("fake: A test."));

        // Signing in, with the token staying out of everything the browser and bots can see.
        const params = await signIn();
        assert.equal(apps.storedApps().fake.status, "connecting");
        assert.equal((await apps.snapshot()).apps.find((a) => a.id === "fake").status, "connecting");
        const done = await apps.finish(params);
        assert.equal(done.error, undefined);
        assert.equal(done.app.id, "fake");
        const snap = await apps.snapshot();
        const view = snap.apps.find((a) => a.id === "fake");
        assert.equal(view.status, "connected");
        assert.deepEqual(view.tools.map((t) => t.name).sort(), ["echo", "whoami"]);
        assert.ok(!JSON.stringify(snap).includes("access-"));
        assert.ok(!JSON.stringify(db.getValue("apps")).includes("access-"));
        assert.ok((await vault.getJson("app:fake")).tokens.access_token.startsWith("access-"));

        // The state only works once.
        assert.match((await apps.finish(params)).error, /expired or was already used/);
        assert.match((await apps.finish(new URLSearchParams({ state: "made-up", code: "x" }))).error, /expired or was already used/);

        // What bots get: the connected app by name in their context, its tools through the apps tool.
        const note = apps.contextNote();
        assert.match(note, /Connected:\\n- Fake \\(fake\\)$/m);
        assert.doesNotMatch(note, /echo|whoami|tools:/, "no tool-name dump");
        assert.doesNotMatch(note, /Not connected|Open \\(fake-open\\)|Keyed \\(fake-keyed\\)|GitHub \\(github\\)/, "no catalog of what isn't connected");
        const all = await apps.appsTool({ action: "list" });
        const fakeListed = all.connected.find((a) => a.app === "fake");
        assert.equal(fakeListed.status, "connected");
        assert.deepEqual(fakeListed.tools.map((t) => t.split(":")[0]).sort(), ["echo", "whoami"]);
        assert.ok(!all.not_connected.some((a) => a.startsWith("fake:")));
        assert.ok(all.not_connected.includes("fake-open: A test."));
        const listed = await apps.appsTool({ action: "tools", app: "fake", names: ["echo"] });
        assert.equal(listed[0].name, "echo");
        assert.deepEqual((await apps.appsTool({ action: "tools", app: "fake" })).map((t) => t.name).sort(), ["echo", "whoami"]);
        assert.equal((await apps.useApp({ app: "fake", tool: "echo", arguments: { text: "hello" } })).text, "hello");
        assert.equal((await apps.useApp({ app: "fake", tool: "echo", arguments: '{"text":"as a string"}' })).text, "as a string");
        await assert.rejects(apps.useApp({ app: "fake", tool: "echo", arguments: [1] }), /must be an object/);
        await assert.rejects(apps.useApp({ app: "nope", tool: "echo" }), /no app called/);

        // An expired access token gets refreshed without the user.
        const before = (await vault.getJson("app:fake")).tokens.access_token;
        await control({ expire: true });
        assert.equal((await apps.useApp({ app: "fake", tool: "echo", arguments: { text: "again" } })).text, "again");
        assert.notEqual((await vault.getJson("app:fake")).tokens.access_token, before);
        assert.equal(apps.storedApps().fake.status, "connected");

        // A revoked sign-in leaves it waiting for the user, not broken.
        await control({ revoke: true });
        await assert.rejects(apps.useApp({ app: "fake", tool: "echo", arguments: { text: "x" } }), /signed out/);
        assert.equal(apps.storedApps().fake.status, "needs-auth");
        assert.match(apps.contextNote(), /Fake \\(fake\\): signed out/);
        assert.equal((await apps.appsTool({ action: "list" })).connected.find((a) => a.app === "fake").status, "needs-auth");

        // Signing in again doesn't register a second client.
        const { registered: once } = await control({});
        assert.equal((await apps.finish(await signIn())).error, undefined);
        assert.equal((await control({})).registered, once);
        assert.equal(apps.storedApps().fake.status, "connected");

        // A refused sign-in doesn't undo one that's working.
        const refused = await signIn();
        refused.set("error", "access_denied");
        assert.equal((await apps.finish(refused)).error, "Access was denied.");
        assert.equal(apps.storedApps().fake.status, "connected");

        // No sign-in, and pasted keys.
        assert.equal((await apps.connect("fake-open", { origin: "http://localhost:9" })).app.status, "connected");
        assert.equal((await apps.useApp({ app: "fake-open", tool: "whoami" })).text, "anyone");
        await assert.rejects(apps.connect("fake-keyed", { origin: "http://localhost:9" }), /Paste your Key/);
        assert.equal((await apps.connect("fake-keyed", { origin: "http://localhost:9", fields: { key: "wrong" } })).app.status, "needs-auth");
        assert.equal((await apps.connect("fake-keyed", { origin: "http://localhost:9", fields: { key: "sekrit" } })).app.status, "connected");
        assert.equal((await apps.useApp({ app: "fake-keyed", tool: "whoami" })).text, "keyed");
        assert.ok(!JSON.stringify(await apps.snapshot()).includes("sekrit"));

        // Google signs in through the server's own client, never one pasted in.
        apps.addAppForTests({ ...base, id: "fake-google", name: "Fake Google", by: "Google", connection: { kind: "client", url: origin + "/mcp", client: "google" } });
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
        await assert.rejects(apps.connect("fake-google", { origin: "http://localhost:9", client: { id: "pasted", secret: "pasted" } }), /isn't set up on this server.*GOOGLE_OAUTH_CLIENT_ID/);
        assert.equal(await vault.getJson("app-client:google"), undefined);
        assert.ok(!(await apps.snapshot()).clients.includes("google"));
        process.env.GOOGLE_OAUTH_CLIENT_ID = "server-client";
        process.env.GOOGLE_OAUTH_CLIENT_SECRET = "server-secret";
        const { authorize: google } = await apps.connect("fake-google", { origin: "http://localhost:9" });
        assert.equal(new URL(google).searchParams.get("client_id"), "server-client");
        assert.ok((await apps.snapshot()).clients.includes("google"));
        assert.ok(!JSON.stringify(await apps.snapshot()).includes("server-secret"));
        await apps.disconnect("fake-google");

        // A service that only accepts localhost: over Tailscale, the user pastes the sign-in back.
        apps.addAppForTests({ ...base, id: "fake-local", name: "Local", connection: { kind: "oauth", url: origin + "/mcp", localhostOnly: true } });
        const { authorize } = await apps.connect("fake-local", { origin: "http://box.tail0.ts.net:4000" });
        const landed = (await fetch(authorize, { redirect: "manual" })).headers.get("location");
        assert.ok(landed.startsWith("http://localhost:4000/api/bots/apps/callback?"));
        assert.equal((await apps.snapshot()).apps.find((a) => a.id === "fake-local").signingIn, true);
        await assert.rejects(apps.finishPasted("fake-local", "not an address"), /whole address/);
        await assert.rejects(apps.finishPasted("fake-open", landed), /another app/);
        assert.equal((await apps.finishPasted("fake-local", "  " + landed + " ")).status, "connected");
        assert.equal((await apps.snapshot()).apps.find((a) => a.id === "fake-local").signingIn, false);
        await assert.rejects(apps.finishPasted("fake-local", landed), /expired or was already used/);
        await apps.disconnect("fake-local");

        // A reset is about bots and chats: the apps stay.
        await svc.resetAll();
        assert.equal(apps.storedApps().fake.status, "connected");

        // Disconnecting forgets the sign-in.
        await apps.disconnect("fake");
        assert.equal(apps.storedApps().fake, undefined);
        assert.equal(await vault.getJson("app:fake"), undefined);
        await apps.disconnect("fake-open");
        await apps.disconnect("fake-keyed");
        process.exit(0);
      `,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, FAKE: origin, OPENCHAT_DATA_DIR: join(dir, "data"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json"), PI_CODING_AGENT_DIR: join(dir, "pi") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(err);
  } finally {
    fake.kill();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
