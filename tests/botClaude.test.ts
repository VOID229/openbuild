// The pi-claude-code bridge bots load (server/bots/claude-code) and Settings → Bots → Claude.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetCacheMarkers, MAX_CACHE_MARKERS, rewriteInitialRequest } from "../server/bots/claude-code/claude-cli.ts";
import claudeCodeExtension from "../server/bots/claude-code/index.ts";
import type { NativeFrame } from "../server/bots/claude-code/native-types.ts";
import { createClaudeCodeProvider } from "../server/bots/claude-code/provider.ts";
import { nativeToolUseId } from "../server/bots/claude-code/transcript.ts";
import { allProfiles, providerId } from "../server/bots/claude.ts";

const ROOT = join(import.meta.dir, "..");
const marker = () => ({ type: "ephemeral", ttl: "1h" });
const cached = (text: string) => ({ type: "text", text, cache_control: marker() });
const count = (payload: unknown) => (JSON.stringify(payload).match(/"cache_control":\{"type"/g) ?? []).length;
const framesFor = (messages: { role: string; content: unknown[] }[]): NativeFrame[] =>
  messages.filter((m) => m.role !== "system").map((m) => ({ type: m.role as "user" | "assistant", message: { role: m.role as "user" | "assistant", content: structuredClone(m.content) } }));

// ------------------------------------------------------------------ cache_control: at most four

test("a replayed request with five cache markers is sent with the latest four", () => {
  // The production 400: Claude Code's tool and two system markers, plus two replay boundaries.
  const messages = [
    { role: "user", content: [cached("first")] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [cached("second")] },
  ];
  const input = { tools: [{ name: "t", input_schema: { type: "object" }, cache_control: marker() }], system: [cached("identity"), cached("prompt")], messages };
  expect(count(input)).toBe(5);
  const rewrite = (injections?: []) => JSON.parse(rewriteInitialRequest(Buffer.from(JSON.stringify(input)), framesFor(messages), undefined, injections).toString());
  // With native system injections, Claude Code's leading system marker is folded first.
  expect(count(rewrite([]))).toBeLessThanOrEqual(MAX_CACHE_MARKERS);
  const output = rewrite();
  expect(count(output)).toBe(MAX_CACHE_MARKERS);
  // The earliest one goes; the boundaries nearest the end keep theirs.
  expect(output.tools[0].cache_control).toBeUndefined();
  expect(output.system.map((b: any) => !!b.cache_control)).toEqual([true, true]);
  expect(output.messages.at(-1).content.at(-1).cache_control).toEqual(marker());
});

test("the budget counts markers inside tool results and leaves schemas, inputs and data alone", () => {
  const schema = { type: "object", properties: { cache_control: { type: "string" } }, required: ["cache_control"] };
  const toolInput = { cache_control: { type: "ephemeral" }, nested: { cache_control: "keep" } };
  const payload = {
    tools: [{ name: "cache_tool", input_schema: structuredClone(schema), cache_control: marker() }],
    system: [cached("system")],
    messages: [
      { role: "user", content: [cached("first")] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "cache_tool", input: structuredClone(toolInput) }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [cached("result")], cache_control: marker() }, cached("after")] },
    ],
  };
  budgetCacheMarkers(payload);
  const kept = [
    ...payload.tools,
    ...payload.system,
    ...payload.messages.flatMap((m: any) => m.content.flatMap((b: any) => [b, ...(b.type === "tool_result" ? b.content : [])])),
  ].filter((b: any) => b.cache_control);
  expect(kept.length).toBe(4);
  expect(payload.tools[0]!.cache_control).toBeUndefined();
  expect(payload.system[0]!.cache_control).toBeUndefined();
  expect(payload.tools[0]!.input_schema).toEqual(schema);
  expect((payload.messages[1]!.content[0] as any).input).toEqual(toolInput);
  expect((payload.messages[2]!.content[1] as any).cache_control).toEqual(marker());
});

test("a request within the budget is left as it was", () => {
  const payload = { system: [cached("a")], messages: [{ content: [cached("b"), { type: "text", text: "c" }] }, { content: "plain" }] };
  const before = structuredClone(payload);
  budgetCacheMarkers(payload);
  expect(payload).toEqual(before);
});

// ------------------------------------------------------------------ replaying Claude Code's own system messages

const captured = [{ role: "system", content: [{ type: "text", text: "native reminder" }], output_config: { effort: "medium" } }];
const replay = (wire: { role: string; content: unknown[]; output_config?: unknown }[], top: Record<string, unknown> = {}) => {
  const frames = framesFor(wire);
  return JSON.parse(rewriteInitialRequest(Buffer.from(JSON.stringify({ ...top, system: [], messages: wire })), frames, structuredClone(captured)).toString());
};
const history = [
  { role: "assistant", content: [{ type: "text", text: "pong" }] },
  { role: "user", content: [{ type: "text", text: "again" }] },
];

test("a model without native system messages gets none restored", () => {
  // Haiku 4.5: Claude Code sends no system-role messages, and the API refuses any.
  const output = replay([{ role: "user", content: [{ type: "text", text: "hi" }] }, ...history]);
  expect(output.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
});

test("restored system messages carry this request's output_config, or none", () => {
  const wire = () => [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "system", content: [{ type: "text", text: "native reminder" }] }, ...history];
  let output = replay(wire(), { thinking: { type: "enabled", budget_tokens: 1024 } });
  expect(output.messages[1].role).toBe("system");
  expect("output_config" in output.messages[1]).toBe(false);
  output = replay(wire(), { output_config: { effort: "high" } });
  expect(output.messages[1].output_config).toEqual({ effort: "high" });
});

// ------------------------------------------------------------------ the bridge itself

test("foreign tool ids become valid, distinct Anthropic ids", () => {
  const ids = ["call_abc|fc_123", "call_abc_fc_123", "x".repeat(80), "x".repeat(80) + "y", "plain_id-1", ""];
  const mapped = ids.map(nativeToolUseId);
  for (const id of mapped) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(new Set(mapped).size).toBe(ids.length);
  expect(nativeToolUseId("plain_id-1")).toBe("plain_id-1");
  expect(nativeToolUseId("call_abc|fc_123")).toBe(nativeToolUseId("call_abc|fc_123"));
});

test("each login is its own provider, and one login's auth check never sees another's", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-claude-profiles-"));
  try {
    const command = join(root, "claude");
    const dirs = [join(root, "primary"), join(root, "second")];
    writeFileSync(command, `#!/bin/sh\nif [ "$CLAUDE_CONFIG_DIR" = "${dirs[0]}" ]; then echo '{"loggedIn":true,"subscriptionType":"max"}'; else echo '{"loggedIn":false}'; fi\n`);
    chmodSync(command, 0o755);
    const providers = dirs.map((configDir, i) => createClaudeCodeProvider({ id: i ? "claude-code-2" : "claude-code", name: i ? "Claude (2)" : "Claude", configDir, command }));
    // An ambient CLAUDE_CONFIG_DIR (from the server's environment) must not move a pinned login.
    const ctx = { env: async (name: string) => (name === "CLAUDE_CONFIG_DIR" || name === "PI_CLAUDE_CODE_CONFIG_DIR" ? "/wrong-account" : undefined), fileExists: async () => false };
    const signal = new AbortController().signal;
    const checks = await Promise.all(providers.map((p) => p.auth.apiKey!.check!({ ctx, signal } as any)));
    expect(checks[0]?.type).toBe("oauth");
    expect(checks[1]).toBeUndefined();
    const resolved = await Promise.all(providers.map((p) => p.auth.apiKey!.resolve({ ctx, signal } as any)));
    providers.forEach((p, i) => {
      expect(resolved[i]?.env?.CLAUDE_CONFIG_DIR).toBe(dirs[i]);
      expect(resolved[i]?.env?.PI_CLAUDE_CODE_COMMAND).toBe(command);
      expect(p.getModels().length).toBeGreaterThan(0);
      expect(p.getModels().every((m) => m.provider === p.id)).toBe(true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the extension registers each provider once", () => {
  const registered: string[] = [];
  const commands: string[] = [];
  claudeCodeExtension(
    { registerProvider: (p) => registered.push(p.id), registerCommand: (name) => commands.push(name) },
    [{ id: "claude-code" }, { id: "claude-code-2", configDir: "/x" }, { id: "claude-code-2", configDir: "/y" }],
  );
  expect(registered).toEqual(["claude-code", "claude-code-2"]);
  expect(commands).toEqual(["claude-code-status"]);
});

// ------------------------------------------------------------------ OpenBuild's side

test("logins keep the provider ids the pi-claude-code package uses", () => {
  expect(providerId("claude2")).toBe("claude-code-2");
  expect(providerId("claude-work")).toBe("claude-code-work");
  const home = mkdtempSync(join(tmpdir(), "openbuild-claude-home-"));
  try {
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".claude-2"));
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "claude2"), `#!/bin/sh\nCLAUDE_CONFIG_DIR="$HOME/.claude-2" exec claude "$@"\n`);
    const profiles = allProfiles([], home, join(home, "bin"));
    expect(profiles.map((p) => [p.id, p.name, p.configDir])).toEqual([
      ["claude-code", "Claude", join(home, ".claude")],
      ["claude-code-2", "Claude (2)", join(home, ".claude-2")],
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** Runs `script` in its own server process: its own data directory, home and fake Claude Code. */
async function inServer(script: string, setup?: (home: string) => void, env: Record<string, string | undefined> = {}) {
  const home = mkdtempSync(join(tmpdir(), "openbuild-bot-claude-"));
  try {
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, "pi"), { recursive: true });
    writeFileSync(join(home, "pi", "settings.json"), JSON.stringify({ packages: ["local/pi-claude-code"] }));
    mkdirSync(join(home, "pi", "local", "pi-claude-code"), { recursive: true });
    writeFileSync(join(home, "pi", "local", "pi-claude-code", "package.json"), JSON.stringify({ name: "@earendil-works/pi-claude-code" }));
    // Claude Code, as far as signing in goes: login prints the link, reads the code, and only "good-code" works.
    const claude = join(home, "claude");
    writeFileSync(claude, `#!/bin/sh
log="$HOME/calls.log"
echo "$CLAUDE_CONFIG_DIR $* key=\${ANTHROPIC_API_KEY:+leaked}\${CLAUDE_CODE_OAUTH_TOKEN:+leaked}" >> "$log"
case "$1 $2" in
  "auth status") if [ -f "$CLAUDE_CONFIG_DIR/in" ]; then echo '{"loggedIn":true,"email":"me@example.com","subscriptionType":"max","authMethod":"claude.ai","accessToken":"SECRET-ACCESS-TOKEN","orgId":"SECRET-ORG"}'; else echo '{"loggedIn":false}'; fi ;;
  "auth login")
    echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
    printf 'Paste code here if prompted > '
    read code
    if [ "$code" = "good-code" ]; then touch "$CLAUDE_CONFIG_DIR/in"; echo "Login successful."; exit 0; fi
    echo "Login failed: That code wasn't accepted ($code)." >&2; exit 1 ;;
  "auth logout") rm -f "$CLAUDE_CONFIG_DIR/in"; echo "Logged out." ;;
esac
`);
    chmodSync(claude, 0o755);
    setup?.(home);
    const child = Bun.spawn([process.execPath, "-e", `import { strict as a } from "node:assert";\n${script}\nprocess.exit(0);`], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, OPENCHAT_DATA_DIR: join(home, "data"), PI_CODING_AGENT_DIR: join(home, "pi"), CLAUDE_BIN: claude, CLAUDE_CONFIG_DIR: "", PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-ant-ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth", ...env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
    return home;
  } catch (e) {
    rmSync(home, { recursive: true, force: true });
    throw e;
  }
}

test("bots load the bundled bridge, without credentials, and not alongside the user's own copy", async () => {
  const home = await inServer(`
    const { readFileSync } = await import("node:fs");
    const svc = await import("./server/bots/service.ts");
    const { piFlags, friendFlags } = await import("./server/bots/extensions.ts");
    const after = (flags, flag) => flags.flatMap((f, i) => (f === "-e" ? [flags[i + 1]] : []));
    let loaded = after(piFlags());
    a.equal(loaded.length, 2);
    const bridge = loaded[1];
    a.match(bridge, /bots\\/claude-code\\/bridge-[a-z0-9]+\\.ts$/);
    const body = readFileSync(bridge, "utf8");
    a.match(body, /server\\/bots\\/claude-code\\/index\\.ts/);
    a.match(body, /"id":"claude-code"/);
    // Where each login is and which Claude Code runs it: nothing more.
    const profiles = JSON.parse(body.slice(body.indexOf("bridge(pi, ") + 11, body.lastIndexOf(");")));
    a.deepEqual(profiles.map((p) => Object.keys(p).sort()), [["command", "configDir", "id", "name"]]);
    a.deepEqual(after(friendFlags(false)), loaded);
    // Same logins, same file: Pi's model listings and running bots aren't disturbed.
    a.equal(after(piFlags())[1], bridge);
    // Disconnecting every login leaves the bridge out; a change is a new file.
    svc.updateSettings({ claude: { off: ["claude-code"], changedAt: 1 } });
    a.equal(after(piFlags()).length, 1);
    svc.updateSettings({ claude: { off: [], changedAt: 2 } });
    a.notEqual(after(piFlags())[1], bridge);
    // The user's own pi-claude-code registers the same providers, so ours stays out.
    svc.updateSettings({ customExtensions: { enabled: true, ids: ["package:local/pi-claude-code"] } });
    loaded = after(piFlags());
    a.equal(loaded.length, 2);
    a.match(loaded[1], /pi\\/local\\/pi-claude-code$/);
    // Junk in the setting is dropped.
    a.deepEqual(svc.updateSettings({ claude: { off: ["claude-code-2", "../evil", 7], changedAt: 3 } }).claude.off, ["claude-code-2"]);
  `);
  rmSync(home, { recursive: true, force: true });
}, 30_000);

test("connecting signs in through Claude Code, and the code goes only to its stdin", async () => {
  const home = await inServer(`
    const { readFileSync, existsSync } = await import("node:fs");
    const claude = await import("./server/bots/claude.ts");
    const svc = await import("./server/bots/service.ts");
    const view = async () => (await claude.logins()).logins[0];
    let login = await view();
    a.equal(login.id, "claude-code");
    a.equal(login.signedIn, false);
    a.equal(login.enabled, true);
    // A wrong code fails, says why, and never repeats the code.
    let sign = await claude.connect("claude-code");
    a.equal(sign.status, "waiting");
    a.match(sign.url, /^https:\\/\\/claude\\.com\\/cai\\/oauth\\/authorize\\?/);
    await a.rejects(claude.submitCode("claude-code", "not-this-flow", "x"), /sign-in is over/);
    await a.rejects(claude.submitCode("claude-code", sign.id, "two words"), /Paste the code/);
    const failed = await claude.submitCode("claude-code", sign.id, "bad-code-123");
    a.equal(failed.status, "failed");
    a.match(failed.error, /wasn't accepted/);
    a.doesNotMatch(failed.error, /bad-code-123/);
    a.equal(failed.url, undefined);
    // The right one signs in and bots use the login.
    svc.updateSettings({ claude: { off: ["claude-code"] } });
    sign = await claude.connect("claude-code");
    const done = await claude.submitCode("claude-code", sign.id, "good-code");
    a.equal(done.status, "connected");
    login = await view();
    a.equal(login.signedIn, true);
    a.equal(login.enabled, true);
    a.equal(login.email, "me@example.com");
    a.equal(login.plan, "max");
    // Nothing OpenBuild keeps holds the code.
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (d) => readdirSync(d).flatMap((n) => { const p = d + "/" + n; return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const file of walk(process.env.OPENCHAT_DATA_DIR)) a.doesNotMatch(readFileSync(file, "latin1"), /good-code/, file);
    // Disconnecting keeps Claude Code signed in; asking to sign out too runs its logout for this login only.
    await claude.disconnect("claude-code", false);
    login = await view();
    a.equal(login.enabled, false);
    a.equal(login.signedIn, true);
    a.doesNotMatch(readFileSync(process.env.HOME + "/calls.log", "utf8"), /logout/);
    await claude.connect("claude-code");
    a.equal((await view()).enabled, true);
    await claude.disconnect("claude-code", true);
    login = await view();
    a.equal(login.signedIn, false);
    a.equal(login.enabled, false);
    a.match(readFileSync(process.env.HOME + "/calls.log", "utf8"), new RegExp(process.env.HOME + "/.claude auth logout"));
    await a.rejects(claude.connect("claude-code-9"), /no such Claude login/);
  `);
  rmSync(home, { recursive: true, force: true });
}, 30_000);

// ------------------------------------------------------------------ fresh installs, enabled extensions, credentials

test("on a fresh install bots get the bridge with no Pi package, and nothing works until Claude Code is there", async () => {
  // No packages in Pi, no extensions picked, no app settings, no Claude Code on the server.
  const home = await inServer(`
    const { existsSync, readdirSync } = await import("node:fs");
    const { piFlags } = await import("./server/bots/extensions.ts");
    const claude = await import("./server/bots/claude.ts");
    const flags = piFlags();
    const loaded = flags.flatMap((f, i) => (f === "-e" ? [flags[i + 1]] : []));
    a.equal(loaded.length, 2);
    a.match(loaded[1], /bridge-[a-z0-9]+\\.ts$/);
    a.ok(flags.includes("--no-extensions"));
    const view = await claude.logins();
    a.equal(view.installed, false);
    a.equal(view.userPackage, false);
    a.deepEqual(view.logins.map((l) => [l.id, l.signedIn, l.enabled]), [["claude-code", false, true]]);
    a.match(view.logins[0].error, /isn't installed/);
    await a.rejects(claude.connect("claude-code"), /isn't installed/);
    // Nothing was started: no sign-in, no Claude config written.
    a.equal(existsSync(process.env.HOME + "/.claude"), false);
  `, (home) => {
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    writeFileSync(join(home, "pi", "settings.json"), "{}");
  }, { CLAUDE_BIN: join(tmpdir(), "no-such-claude-binary") });
  rmSync(home, { recursive: true, force: true });
}, 30_000);

test("extensions already enabled for bots: only the user's own pi-claude-code keeps OpenBuild's out", async () => {
  const home = await inServer(`
    const svc = await import("./server/bots/service.ts");
    const claude = await import("./server/bots/claude.ts");
    const { piFlags } = await import("./server/bots/extensions.ts");
    const loaded = () => { const f = piFlags(); return f.flatMap((x, i) => (x === "-e" ? [f[i + 1]] : [])).slice(1); };
    const bridge = (list) => list.filter((p) => /bridge-[a-z0-9]+\\.ts$/.test(p)).length;
    const pick = (ids, enabled = true) => svc.updateSettings({ customExtensions: { enabled, ids } });
    // Another Claude bridge (its own "pi-claude" provider) loads beside ours.
    pick(["package:local/pi-claude-bridge"]);
    a.equal(bridge(loaded()), 1);
    a.equal(loaded().length, 2);
    // The user's pi-claude-code, by package name even in a renamed folder: ours stays out, theirs loads once.
    pick(["package:local/renamed"]);
    a.equal(bridge(loaded()), 0);
    a.deepEqual(loaded().map((p) => p.split("/").pop()), ["renamed"]);
    a.equal((await claude.logins()).userPackage, true);
    // From git or npm, by its source.
    pick(["package:git:github.com/earendil-works/pi-claude-code"]);
    a.equal(bridge(loaded()), 0);
    pick(["package:npm:@earendil-works/pi-claude-code@0.2.0"]);
    a.equal(bridge(loaded()), 0);
    // Picked but switched off as a whole, or since uninstalled from Pi: ours is back.
    pick(["package:local/renamed"], false);
    a.equal(bridge(loaded()), 1);
    pick(["package:local/gone"]);
    a.deepEqual(loaded().map((p) => /bridge-/.test(p)), [true]);
    // The wrapper registers each login exactly once.
    const { readFileSync } = await import("node:fs");
    const body = readFileSync(loaded()[0], "utf8");
    const ids = JSON.parse(body.slice(body.indexOf("bridge(pi, ") + 11, body.lastIndexOf(");"))).map((p) => p.id);
    a.deepEqual(ids, [...new Set(ids)]);
  `, (home) => {
    const pkg = (dir: string, name: string) => {
      mkdirSync(join(home, "pi", "local", dir), { recursive: true });
      writeFileSync(join(home, "pi", "local", dir, "package.json"), JSON.stringify({ name }));
    };
    pkg("pi-claude-bridge", "@vanillagreen/pi-claude-bridge");
    pkg("renamed", "@earendil-works/pi-claude-code");
    writeFileSync(join(home, "pi", "settings.json"), JSON.stringify({
      packages: ["local/pi-claude-bridge", "local/renamed", "git:github.com/earendil-works/pi-claude-code", "npm:@earendil-works/pi-claude-code@0.2.0"],
    }));
  });
  rmSync(home, { recursive: true, force: true });
}, 30_000);

test("one directory is one login, whatever names point at it", () => {
  const home = mkdtempSync(join(tmpdir(), "openbuild-claude-dupes-"));
  try {
    for (const d of [".claude", ".claude-2"]) mkdirSync(join(home, d));
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "claude2"), `#!/bin/sh\nCLAUDE_CONFIG_DIR="$HOME/.claude-2" exec claude "$@"\n`);
    writeFileSync(join(home, "bin", "claude3"), `#!/bin/sh\nCLAUDE_CONFIG_DIR="$HOME/.claude" exec claude "$@"\n`);
    const saved = [
      { id: "a", name: "Work", runtime: "claude", configDir: join(home, ".claude-2") },
      { id: "b", name: "Again", runtime: "claude", configDir: join(home, ".claude-2") },
      { id: "c", name: "Default", runtime: "claude", configDir: join(home, ".claude") },
    ];
    const profiles = allProfiles(saved, home, join(home, "bin"));
    expect(new Set(profiles.map((p) => p.id)).size).toBe(profiles.length);
    expect(new Set(profiles.map((p) => p.configDir)).size).toBe(profiles.length);
    expect(profiles.map((p) => p.configDir).sort()).toEqual([join(home, ".claude"), join(home, ".claude-2")]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude's credentials never reach OpenBuild's answers, files or Claude Code's sign-in", async () => {
  const home = await inServer(`
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const claude = await import("./server/bots/claude.ts");
    const sign = await claude.connect("claude-code");
    await claude.submitCode("claude-code", sign.id, "good-code");
    // Status keeps only what Settings shows, never a token or org id Claude Code might print.
    const view = JSON.stringify(await claude.logins());
    a.match(view, /me@example\\.com/);
    for (const secret of ["SECRET-ACCESS-TOKEN", "SECRET-ORG", "good-code", "sk-ant-ambient", "ambient-oauth"]) a.doesNotMatch(view, new RegExp(secret));
    // Ambient API keys never reach Claude Code: a subscription sign-in can't quietly become API billing.
    const calls = readFileSync(process.env.HOME + "/calls.log", "utf8").trim().split("\\n");
    a.ok(calls.length >= 3);
    for (const line of calls) a.match(line, / key=$/);
    // Nothing OpenBuild writes holds any of them.
    const walk = (d) => readdirSync(d).flatMap((n) => { const p = d + "/" + n; return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const file of walk(process.env.OPENCHAT_DATA_DIR)) for (const secret of ["SECRET-ACCESS-TOKEN", "good-code", "sk-ant-ambient", "ambient-oauth"]) a.doesNotMatch(readFileSync(file, "latin1"), new RegExp(secret), file);
    // Wrapper files (and their folder) are private to the user.
    (await import("./server/bots/extensions.ts")).piFlags();
    a.equal(statSync(process.env.OPENCHAT_DATA_DIR + "/bots/claude-code").mode & 0o077, 0);
    for (const file of walk(process.env.OPENCHAT_DATA_DIR + "/bots/claude-code")) a.equal(statSync(file).mode & 0o077, 0, file);
  `);
  rmSync(home, { recursive: true, force: true });
}, 30_000);

test("the cache budget keeps the request valid however the markers are spread", () => {
  const all = (payload: any) => [
    ...(payload.tools ?? []),
    ...(payload.system ?? []),
    ...payload.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content.flatMap((b: any) => [b, ...(b.type === "tool_result" && Array.isArray(b.content) ? b.content : [])]) : [])),
  ];
  const markers = (payload: any) => all(payload).filter((b: any) => b.cache_control).map((b: any) => b.text ?? b.name ?? b.type);
  // Many markers in history alone: the four nearest the end stay.
  const history = { messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [cached(`m${i}`)] })) };
  budgetCacheMarkers(history);
  expect(markers(history)).toEqual(["m4", "m5", "m6", "m7"]);
  // Markers nested in tool results count, and string content is skipped without error.
  const nested = {
    system: [cached("s")],
    messages: [
      { role: "user", content: "plain text" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [cached("r1"), cached("r2")] }, { type: "tool_result", tool_use_id: "b", content: "text result" }] },
      { role: "user", content: [cached("last")] },
    ],
  };
  budgetCacheMarkers(nested);
  expect(markers(nested)).toEqual(["s", "r1", "r2", "last"]);
  // A 1h marker is never left after a 5m one: dropping only the earliest keeps their order.
  const ttl = { system: [cached("a"), cached("b")], messages: [{ content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }, { type: "text", text: "d", cache_control: { type: "ephemeral" } }, { type: "text", text: "e", cache_control: { type: "ephemeral" } }] }] };
  budgetCacheMarkers(ttl);
  const ttls = all(ttl).filter((b: any) => b.cache_control).map((b: any) => b.cache_control.ttl ?? "5m");
  expect(ttls).toEqual(["1h", "5m", "5m", "5m"]);
  // Running it twice changes nothing more.
  const again = structuredClone(nested);
  budgetCacheMarkers(again);
  expect(again).toEqual(nested);
});

// ------------------------------------------------------------------ every bridge launch drops ambient auth

/** A Claude Code that answers auth status, discovery and one streamed request, logging what each launch saw. */
const FAKE_CLI = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const ambient = JSON.parse(process.env.AMBIENT_NAMES);
const args = process.argv.slice(2);
const kind = args[0] === "auth" ? "status" : args.includes("--system-prompt-file") ? "request" : "discovery";
const base = process.env.ANTHROPIC_BASE_URL;
appendFileSync(process.env.LAUNCH_LOG, JSON.stringify({ kind, dir: process.env.CLAUDE_CONFIG_DIR, base: base && new URL(base).hostname, leaked: ambient.filter((n) => n in process.env) }) + "\\n");
if (kind === "status") {
  // A token in the environment would sign any directory in, as Claude Code does.
  const loggedIn = process.env.CLAUDE_CONFIG_DIR === process.env.SIGNED_IN_DIR || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  console.log(JSON.stringify(loggedIn ? { loggedIn, authMethod: "claude.ai", subscriptionType: "max" } : { loggedIn }));
  process.exit(0);
}
const out = (v) => console.log(JSON.stringify(v));
const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { models: [
        { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Efficient", supportsAdaptiveThinking: true },
      ] } } });
      continue;
    }
    const echo = frame.uuid ? { user_message_uuids: [frame.uuid] } : {};
    if (frame.shouldQuery === false) { out({ type: "result", num_turns: 0, ...echo }); continue; }
    if (frame.type !== "user") continue;
    for (const event of [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      { type: "message_stop" },
    ]) out({ type: "stream_event", event });
    out({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage } });
    out({ type: "result", subtype: "success", is_error: false, usage, ...echo });
  }
})();
`;

test("status, discovery and requests for each login never see the server's Claude credentials or backend", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-claude-launch-"));
  try {
    const cli = join(root, "claude");
    writeFileSync(cli, FAKE_CLI);
    chmodSync(cli, 0o755);
    const dirs = [join(root, "one"), join(root, "two")];
    for (const d of dirs) mkdirSync(d);
    const ambient = {
      ANTHROPIC_API_KEY: "sk-ant-ambient",
      ANTHROPIC_AUTH_TOKEN: "ambient-bearer",
      CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth",
      ANTHROPIC_BASE_URL: "https://ambient-proxy.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_CUSTOM_HEADERS: "x-auth: ambient",
    };
    // Its own process: the ambient values go in process.env, where Pi's would be.
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from "node:assert";
      import { readFileSync } from "node:fs";
      const { createClaudeCodeProvider } = await import("./server/bots/claude-code/provider.ts");
      const dirs = ${JSON.stringify(dirs)};
      const [one, two] = dirs.map((configDir, i) => createClaudeCodeProvider({ id: i ? "claude-code-2" : "claude-code", configDir, command: ${JSON.stringify(cli)} }));
      const signal = new AbortController().signal;
      const ctx = { env: async () => undefined, fileExists: async () => false };

      // Provider checks: only the login that's signed in counts. The second doesn't borrow a token.
      a.equal((await one.auth.apiKey.check({ ctx, signal }))?.type, "oauth");
      a.equal(await two.auth.apiKey.check({ ctx, signal }), undefined);

      // Discovery works (upstream refused the ambient base URL) and lists this login's models.
      await one.refreshModels({ allowNetwork: true, force: true, signal, publish: async ({ update }) => (update?.(), true) });
      const models = one.filterModels(one.getModels());
      a.deepEqual(models.map((m) => m.id), ["claude-sonnet-5"]);
      a.ok(models.every((m) => m.provider === "claude-code"));

      // A request, the way Pi sends one: resolve, then stream with that environment.
      const ask = async (provider, model) => {
        const resolved = await provider.auth.apiKey.resolve({ ctx, signal });
        const stream = provider.stream(model, { systemPrompt: "system", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] }, { env: resolved.env, signal });
        let done;
        for await (const event of stream) if (event.type === "done" || event.type === "error") done = event;
        return done;
      };
      const answered = await ask(one, models[0]);
      a.equal(answered.type, "done", JSON.stringify(answered).slice(0, 400));
      a.deepEqual(answered.message.content.filter((b) => b.type === "text").map((b) => b.text), ["ok"]);
      // The second login isn't signed in, and an ambient token mustn't make it look like it is.
      const refused = await ask(two, { ...models[0], provider: "claude-code-2" });
      a.equal(refused.type, "error");
      a.match(refused.error.errorMessage, /log|sign/i);

      const launches = readFileSync(process.env.LAUNCH_LOG, "utf8").trim().split("\\n").map((l) => JSON.parse(l));
      for (const kind of ["status", "discovery", "request"]) a.ok(launches.some((l) => l.kind === kind), "no " + kind + " launch");
      for (const l of launches) {
        // A request's ANTHROPIC_BASE_URL is the relay's, checked below; anything else is a leak.
        a.deepEqual(l.leaked.filter((n) => !(l.kind === "request" && n === "ANTHROPIC_BASE_URL")), [], JSON.stringify(l));
        a.ok(dirs.includes(l.dir), JSON.stringify(l));
        // Requests go to the bridge's own loopback relay, never the ambient backend.
        if (l.kind === "request") a.match(l.base, /^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/, JSON.stringify(l));
        else a.equal(l.base, undefined, JSON.stringify(l));
      }
      a.ok(launches.filter((l) => l.dir === dirs[1]).every((l) => l.kind === "status"), "the second login only ever had its status asked");
      process.exit(0);
    `], {
      cwd: ROOT,
      env: { ...process.env, ...ambient, HOME: root, SIGNED_IN_DIR: dirs[0], LAUNCH_LOG: join(root, "launches.jsonl"), AMBIENT_NAMES: JSON.stringify(Object.keys(ambient)) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err, out] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
