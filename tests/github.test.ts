import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_CATALOG } from "../shared/apps";
import { installUrls, isReadTool, manageUrl } from "../shared/github";

test("read-only lets through only tools the server marks read-only and whose names read", () => {
  const ro = { readOnly: true };
  for (const name of ["get_file_contents", "list_issues", "search_code", "issue_read", "pull_request_read", "get_me"]) expect(isReadTool(name, ro)).toBe(true);
  // Unmarked, unknown, or a write whatever its marking.
  expect(isReadTool("get_file_contents", {})).toBe(false);
  expect(isReadTool("get_file_contents", undefined)).toBe(false);
  for (const name of ["create_issue", "issue_write", "merge_pull_request", "push_files", "delete_file", "update_pull_request", "list_and_delete", "run_workflow", "add_issue_comment", "request_copilot_review", "create_pull_request", "list_pull_requests_and_merge"]) expect(isReadTool(name, ro)).toBe(false);
});

test("install and manage links go to the right account", () => {
  expect(installUrls("openbuild", 42)).toEqual({ personal: "https://github.com/apps/openbuild/installations/new/permissions?target_id=42", org: "https://github.com/apps/openbuild/installations/new" });
  expect(manageUrl({ id: 7, account: "octo", accountType: "User" })).toBe("https://github.com/settings/installations/7");
  expect(manageUrl({ id: 8, account: "acme", accountType: "Organization" })).toBe("https://github.com/organizations/acme/settings/installations/8");
});

test("the bots' GitHub app signs in through OpenBuild's GitHub credential and starts read-only", () => {
  const github = APP_CATALOG.find((a) => a.id === "github")!;
  expect(github.githubAuth).toBe(true);
  expect(github.fields?.[0]?.id).toBe("access");
  expect(github.fields?.[0]?.options?.[0]?.value).toBe("read");
  expect(github.connection.kind === "token" && github.connection.headers["X-MCP-Readonly"]).toBe("{readonly}");
});

test("GitHub App: device flow, installations, refresh, read-only, disconnect and revoke against a fake GitHub", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-github-"));
  const fake = Bun.spawn([process.execPath, join(import.meta.dir, "fakeGithub.ts")], { stdout: "pipe", stderr: "inherit" });
  try {
    const { value } = await fake.stdout.getReader().read();
    const origin = new TextDecoder().decode(value).trim();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        const { default: assert } = await import("node:assert/strict");
        const gh = await import("./server/github/auth.ts");
        const { githubRoutes } = await import("./server/github/routes.ts");
        const apps = await import("./server/bots/apps.ts");
        const vault = await import("./server/vault.ts");
        const { GITHUB_ACCESS_FIELD } = await import("./shared/apps.ts");
        const origin = process.env.FAKE;
        const control = (body) => fetch(origin + "/control", body ? { method: "POST", body: JSON.stringify(body) } : undefined).then((r) => r.json());
        const until = async (check, what) => {
          for (let i = 0; i < 100; i++) { if (await check()) return; await Bun.sleep(20); }
          throw new Error("Timed out waiting for " + what);
        };
        const noTokens = (value, what) => assert.ok(!/gh[ur]_fake|device-\\d/.test(JSON.stringify(value)), what + " leaks a token or device code");
        const signIn = async (owner = "owner-a") => {
          const { flowId, status } = await gh.startDevice(owner);
          const code = "device-" + Object.keys((await control()).devices).length;
          await control({ approve: code });
          await until(() => gh.deviceStatus(flowId, owner).status === "connected", "the sign-in");
          return { flowId, status };
        };

        // An install from before the GitHub App: the saved token works as it did.
        await vault.setKeys("github", [{ secret: "pat-settings" }]);
        assert.deepEqual(await gh.githubToken("reader"), { token: "pat-settings", source: "pat" });
        assert.equal((await gh.view()).legacy, true);
        assert.equal((await gh.view()).mode, "pat");

        // Device flow: the browser sees the user code, never the device code, and only its own sign-in.
        const started = await gh.startDevice("owner-a");
        assert.equal(started.status.status, "pending");
        assert.match(started.status.userCode, /^CODE-/);
        noTokens(started, "the start");
        assert.throws(() => gh.deviceStatus(started.flowId, "owner-b"), /somewhere else/);
        assert.throws(() => gh.cancelDevice(started.flowId, "owner-b"), /somewhere else/);
        assert.equal(gh.deviceStatus(started.flowId, "owner-a").status, "pending");
        await control({ approve: "device-1" });
        await until(() => gh.deviceStatus(started.flowId, "owner-a").status === "connected", "the sign-in");
        assert.equal(gh.deviceStatus(started.flowId, "owner-a").login, "octo");
        const view = await gh.view();
        assert.equal(view.mode, "app");
        assert.equal(view.app.login, "octo");
        assert.equal(view.installPersonalUrl, "https://github.com/apps/openbuild-test/installations/new/permissions?target_id=42");
        assert.equal(view.installOrgUrl, "https://github.com/apps/openbuild-test/installations/new");
        noTokens(view, "the view");
        // The app's token now, and never the saved personal access token.
        assert.deepEqual(await gh.githubToken("reader"), { token: "ghu_fake1", source: "app" });
        assert.equal((await gh.githubToken("mcp", { pasted: "pat-pasted" })).source, "app");

        // A personal account with selected repositories, and an organization with all of them.
        const installs = await gh.installations();
        noTokens(installs, "the installations");
        assert.deepEqual(installs.map((i) => [i.account, i.accountType, i.repositorySelection]), [["octo", "User", "selected"], ["acme", "Organization", "all"]]);
        assert.deepEqual(installs[0].repositories, [{ name: "octo/sel", private: true }]);
        assert.equal(installs[0].manageUrl, "https://github.com/settings/installations/11");
        assert.equal(installs[1].manageUrl, "https://github.com/organizations/acme/settings/installations/22");

        // Bots: the GitHub app reaches the selected repository only, and is read-only until the user says otherwise.
        apps.addAppForTests({ id: "fake-gh", name: "Fake GitHub", by: "Test", description: "A test.", category: "code", docs: "https://example.com", githubAuth: true,
          connection: { kind: "token", url: origin + "/mcp", headers: { Authorization: "Bearer {token}", "X-MCP-Readonly": "{readonly}" } },
          fields: [GITHUB_ACCESS_FIELD, { id: "token", label: "Personal access token", secret: true }] });
        const connected = await apps.connect("fake-gh", { origin: "http://localhost:9", fields: {} });
        assert.equal(connected.app.status, "connected", connected.app.error);
        assert.equal(apps.storedApps()["fake-gh"].fields.access, "read");
        noTokens(await apps.snapshot(), "the apps snapshot");
        assert.equal(await vault.getJson("app:fake-gh").then((s) => s?.fields?.token), undefined);
        const read = await apps.useApp({ app: "fake-gh", tool: "get_file_contents", arguments: { owner: "octo", repo: "sel", path: "README.md" } });
        assert.equal(read.text, "contents of octo/sel/README.md");
        const denied = await apps.useApp({ app: "fake-gh", tool: "get_file_contents", arguments: { owner: "octo", repo: "unsel", path: "README.md" } });
        assert.equal(denied.isError, true);
        assert.match(denied.text, /404/);
        await assert.rejects(apps.useApp({ app: "fake-gh", tool: "create_issue", arguments: { owner: "octo", repo: "sel", title: "x" } }), /read-only in OpenBuild/);
        await assert.rejects(apps.useApp({ app: "fake-gh", tool: "made_up_tool", arguments: {} }), /read-only in OpenBuild/);
        let fakeState = await control();
        assert.equal(fakeState.writes, 0);
        assert.ok(fakeState.readonlyHeaders.length && fakeState.readonlyHeaders.every((h) => h === "true"));
        assert.match(apps.contextNote(), /Fake GitHub.*Read-only/);
        await apps.connect("fake-gh", { origin: "http://localhost:9", fields: { access: "write" } });
        assert.equal((await apps.useApp({ app: "fake-gh", tool: "create_issue", arguments: { owner: "octo", repo: "sel", title: "x" } })).text, "created");
        fakeState = await control();
        assert.equal(fakeState.writes, 1);
        assert.equal(fakeState.readonlyHeaders.at(-1), "false");
        await apps.connect("fake-gh", { origin: "http://localhost:9", fields: { access: "read" } });

        // Refresh: one at a time, with no client secret, the new pair saved, the old pair dead.
        await control({ expiresIn: 60 });
        await signIn();
        const before = await control();
        const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => gh.githubToken("reader")));
        const after = await control();
        assert.equal(after.refreshes - before.refreshes, 1);
        assert.equal(after.secretsSeen, 0);
        assert.equal(new Set(tokens.map((t) => t.token)).size, 1);
        const fresh = tokens[0].token;
        assert.ok(after.access.includes(fresh));
        assert.ok(!after.access.includes("ghu_fake" + (Number(fresh.slice(8)) - 1)), "the old access token still works");
        // The CLI never refreshes: an expiring token it can't renew isn't used.
        await control({ expiresIn: 1 });
        await signIn();
        await Bun.sleep(1100);
        const cliBefore = (await control()).refreshes;
        assert.equal(await gh.githubToken("releases", { refresh: false }), undefined);
        assert.equal((await control()).refreshes, cliBefore);

        // A disconnect while a refresh is under way wins: the refreshed tokens are thrown away.
        await control({ refreshDelay: 300 });
        const racing = gh.githubToken("reader");
        await Bun.sleep(50);
        await gh.disconnect();
        assert.equal(await racing, undefined);
        await control({ refreshDelay: 0 });
        const off = await gh.view();
        assert.equal(off.mode, "off");
        assert.equal(off.app, undefined);
        assert.equal(off.hasPat, true);
        noTokens(await vault.getJson("github-auth"), "the record after disconnect");
        // ...and nothing falls back to the personal access token that's still saved.
        assert.equal(await gh.githubToken("reader"), undefined);
        assert.equal(await gh.githubToken("skills"), undefined);
        assert.equal(await gh.githubToken("mcp", { pasted: "pat-pasted" }), undefined);
        await apps.githubChanged();
        assert.equal(apps.storedApps()["fake-gh"].status, "needs-auth");
        await assert.rejects(apps.useApp({ app: "fake-gh", tool: "get_file_contents", arguments: { owner: "octo", repo: "sel", path: "x" } }), /signed out/);
        // Picking the token again is an explicit act.
        await gh.usePat();
        assert.deepEqual(await gh.githubToken("reader"), { token: "pat-settings", source: "pat" });

        // A refresh token GitHub no longer takes signs the user out.
        await control({ expiresIn: 1 });
        await signIn();
        await control({ dropRefresh: true });
        await Bun.sleep(1100);
        assert.equal(await gh.githubToken("reader"), undefined);
        assert.equal((await gh.view()).app.signedOut, true);

        // A sign-in approved after it was cancelled is thrown away.
        await gh.usePat();
        const late = await gh.startDevice("owner-a");
        gh.cancelDevice(late.flowId, "owner-a");
        await control({ approve: "device-" + Object.keys((await control()).devices).length });
        await Bun.sleep(200);
        assert.equal(gh.deviceStatus(late.flowId, "owner-a").status, "cancelled");
        assert.equal((await gh.view()).mode, "pat");

        // Revoking a leaked token: deleted here, then both tokens sent to GitHub's revocation API.
        await control({ expiresIn: 28800 });
        await signIn();
        const record = await vault.getJson("github-auth");
        await gh.revokeLeaked();
        const revoked = (await control()).revoked;
        assert.ok(revoked.includes(record.app.access) && revoked.includes(record.app.refresh));
        assert.equal((await gh.view()).mode, "off");

        // GitHub tokens are never in account key sync.
        await signIn();
        noTokens(await vault.allSecrets(), "key sync");

        // The routes: a sign-in belongs to the browser that started it.
        const routes = githubRoutes((handler) => handler);
        await gh.usePat();
        const start = await routes["/api/github/device"].POST(new Request("http://localhost/api/github/device", { method: "POST", headers: { cookie: "openbuild_session=" + "a".repeat(64) } }));
        const cookie = start.headers.get("set-cookie");
        assert.match(cookie, /^openbuild_github_flow=[a-f0-9]{64}; Path=\\/api\\/github\\/device; HttpOnly; SameSite=Strict/);
        const body = await start.json();
        noTokens(body, "the start route");
        const flowCookie = cookie.split(";")[0];
        const look = (headers) => routes["/api/github/device/:id"].GET(Object.assign(new Request("http://localhost/api/github/device/" + body.flowId, { headers }), { params: { id: body.flowId } }));
        assert.equal((await look({ cookie: flowCookie + "; openbuild_session=" + "a".repeat(64) })).status, 200);
        assert.equal((await look({ cookie: "openbuild_session=" + "a".repeat(64) })).status, 403);
        assert.equal((await look({ cookie: flowCookie + "; openbuild_session=" + "b".repeat(64) })).status, 403);
        const stop = (headers) => routes["/api/github/device/:id"].DELETE(Object.assign(new Request("http://localhost/api/github/device/" + body.flowId, { method: "DELETE", headers }), { params: { id: body.flowId } }));
        assert.equal((await stop({ cookie: "openbuild_github_flow=" + "c".repeat(64) + "; openbuild_session=" + "a".repeat(64) })).status, 403);
        assert.equal((await stop({ cookie: flowCookie + "; openbuild_session=" + "a".repeat(64) })).status, 200);
        process.exit(0);
      `,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          FAKE: origin,
          OPENBUILD_GITHUB_ORIGIN: origin,
          OPENBUILD_GITHUB_API_ORIGIN: origin,
          OPENBUILD_GITHUB_APP_CLIENT_ID: "test-client",
          OPENBUILD_GITHUB_APP_SLUG: "openbuild-test",
          OPENCHAT_DATA_DIR: join(dir, "data"),
          OPENCHAT_SECRETS: "file",
          OPENCHAT_SECRETS_FILE: join(dir, "secrets.json"),
          PI_CODING_AGENT_DIR: join(dir, "pi"),
        },
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
