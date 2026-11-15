// The pi-claude-code bridge bots load (server/bots/claude-code) and Settings → Bots → Claude.
import { expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetCacheMarkers, MAX_CACHE_MARKERS, rewriteInitialRequest } from "../server/bots/claude-code/claude-cli.ts";
import claudeCodeExtension from "../server/bots/claude-code/index.ts";
import type { NativeFrame } from "../server/bots/claude-code/native-types.ts";
import { createClaudeCodeProvider, KEEP_LOGIN_FAILED_CHECKS, KEEP_LOGIN_MS } from "../server/bots/claude-code/provider.ts";
import { MISSING_TOOL_RESULT, nativeToolUseId, prepareFrames, prepareMessages, prepareNativeTranscript } from "../server/bots/claude-code/transcript.ts";
import { allProfiles, providerId } from "../server/bots/claude.ts";
import { spawnScript } from "./spawnScript";

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

test("a status check that fails to run keeps the login it last found; a logout still hides it", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-claude-flaky-"));
  try {
    const command = join(root, "claude");
    const mode = join(root, "mode");
    // `claude auth status` answers with whatever `mode` holds: a login, nothing at all, or a logout.
    writeFileSync(command, `#!/bin/sh\ncase "$(cat "${mode}")" in\n  ok) echo '{"loggedIn":true,"subscriptionType":"max"}' ;;\n  out) echo '{"loggedIn":false}' ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(command, 0o755);
    const provider = createClaudeCodeProvider({ id: "claude-code", configDir: join(root, "config"), command });
    const ctx = { env: async () => undefined, fileExists: async () => false };
    const check = () => provider.auth.apiKey!.check!({ ctx, signal: new AbortController().signal } as any);

    // Never seen signed in: a failed check proves nothing either way, and shows nothing.
    writeFileSync(mode, "broken");
    expect(await check()).toBeUndefined();
    writeFileSync(mode, "ok");
    expect((await check())?.type).toBe("oauth");
    // Pi checks on every model refresh and hides the models of a provider whose check comes back empty.
    writeFileSync(mode, "broken");
    expect((await check())?.type).toBe("oauth");
    writeFileSync(mode, "out");
    expect(await check()).toBeUndefined();
    writeFileSync(mode, "broken");
    expect(await check()).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a login kept through failed status checks lapses after a few of them, or a few minutes", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-claude-lapse-"));
  try {
    const command = join(root, "claude");
    const mode = join(root, "mode");
    writeFileSync(command, `#!/bin/sh\nif [ "$(cat "${mode}")" = ok ]; then echo '{"loggedIn":true,"subscriptionType":"max"}'; else exit 1; fi\n`);
    chmodSync(command, 0o755);
    const provider = createClaudeCodeProvider({ id: "claude-code", configDir: join(root, "config"), command });
    const ctx = { env: async () => undefined, fileExists: async () => false };
    const check = () => provider.auth.apiKey!.check!({ ctx, signal: new AbortController().signal } as any);

    // A status check that keeps failing would keep the models listed, and a turn would fail at sign-in
    // instead of moving to a fallback when its model is picked: only so many failures are covered.
    writeFileSync(mode, "ok");
    expect((await check())?.type).toBe("oauth");
    writeFileSync(mode, "broken");
    for (let i = 0; i < KEEP_LOGIN_FAILED_CHECKS; i++) expect((await check())?.type).toBe("oauth");
    expect(await check()).toBeUndefined();
    // The next one that finds the login starts over.
    writeFileSync(mode, "ok");
    expect((await check())?.type).toBe("oauth");

    // And only for so long after the last good check.
    writeFileSync(mode, "broken");
    try {
      setSystemTime(new Date(Date.now() + KEEP_LOGIN_MS - 1_000));
      expect((await check())?.type).toBe("oauth");
      setSystemTime(new Date(Date.now() + 2_000));
      expect(await check()).toBeUndefined();
    } finally {
      setSystemTime();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

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
    const { code, stderr: err, stdout: out } = await spawnScript(`import { strict as a } from "node:assert";\n${script}\nprocess.exit(0);`, { HOME: home, OPENCHAT_DATA_DIR: join(home, "data"), PI_CODING_AGENT_DIR: join(home, "pi"), CLAUDE_BIN: claude, CLAUDE_CONFIG_DIR: "", PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-ant-ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth", ...env });
    expect(err + out).toBe("");
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
    const { code, stderr: err, stdout: out } = await spawnScript(`
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
    `, { ...ambient, HOME: root, SIGNED_IN_DIR: dirs[0], LAUNCH_LOG: join(root, "launches.jsonl"), AMBIENT_NAMES: JSON.stringify(Object.keys(ambient)) });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// ------------------------------------------------------------------ Pi's history against the request Claude Code builds

// A bot's history as Pi holds it, in the shapes of the session that failed over: a compacted summary,
// a kept turn that starts at a reply (the split turn), notices that arrive with tool results, and
// replies with thinking only.
const OPUS = { provider: "claude-code", api: "claude-code-stream-json", id: "claude-opus-5-5" } as any;
const piUser = (...content: unknown[]) => ({ role: "user", content, timestamp: 1 }) as any;
const piSaid = (...content: unknown[]) => ({ role: "assistant", content, provider: OPUS.provider, api: OPUS.api, model: OPUS.id, stopReason: content.some((b: any) => b.type === "toolCall") ? "toolUse" : "stop", timestamp: 1 }) as any;
const piResult = (id: string, text: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 1 }) as any;
const piText = (text: string) => ({ type: "text", text });
const piThinking = (thinking: string) => ({ type: "thinking", thinking, thinkingSignature: "c2lnbmF0dXJl" });
const piCall = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: "gh pr view" } });
const piImage = () => ({ type: "image", mimeType: "image/png", data: "aGk=" });
const framesOf = (messages: unknown[]) => prepareFrames(prepareMessages(messages as any, OPUS));
const shape = (frames: NativeFrame[]) =>
  frames.map((f) => `${f.type}: ${f.message.content.map((b: any) => (b.type === "tool_result" ? `result ${b.tool_use_id}${b.is_error ? " (error)" : ""}` : b.type === "tool_use" ? `call ${b.id}` : b.type === "text" ? b.text : b.type)).join(" | ")}`);

const SUMMARY = "The conversation history before this point was compacted into the following summary: ## Goal …";
const NOTICE = (n: number) => `Conversation dd8e6bad (direct, “Dr Eggbot”):\nTo-do list, 2/8 done …\n[${n}] Outis: next?`;

test("a reply with no visible output is left out of the replay, and the messages around it are one", () => {
  const history = [
    piUser(piText(SUMMARY)),
    piSaid(piText("The connectors plan is complete.")),
    piUser(piText(NOTICE(1))),
    piSaid(piThinking("Check the PR."), piCall("toolu_a"), piCall("toolu_b")),
    piResult("toolu_a", "Sent as [fc7fb3de]"),
    piResult("toolu_b", "Sent as [803cbe02]"),
    // The reply that failed the next request over: signed thinking, no text, no tool call.
    piSaid(piThinking("Both sent. Nothing more to say.")),
    piUser(piText(NOTICE(2))),
  ];
  expect(shape(framesOf(history))).toEqual([
    `user: ${SUMMARY}`,
    "assistant: The connectors plan is complete.",
    `user: ${NOTICE(1)}`,
    "assistant: thinking | call toolu_a | call toolu_b",
    `user: result toolu_a | result toolu_b | ${NOTICE(2)}`,
  ]);
  // The same for blank text, with or without thinking before it, and for redacted thinking.
  for (const blank of [[piText("\n\n")], [piThinking("Hm."), piText(" ")], [{ ...piThinking("[Reasoning redacted]"), redacted: true }]]) {
    expect(shape(framesOf([piUser(piText("first")), piSaid(...blank), piUser(piText("second"))]))).toEqual(["user: first | second"]);
  }
  // Thinking beside something visible stays as it was.
  expect(shape(framesOf([piUser(piText("first")), piSaid(piThinking("Hm."), piText("A reply.")), piUser(piText("second"))]))).toEqual(["user: first", "assistant: thinking | A reply.", "user: second"]);
});

test("tool changes after a reply with no visible output are placed by the replies that are replayed", () => {
  const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
  const system = (extra: Record<string, unknown>) => ({ role: "system", content: "", timestamp: 1, ...extra });
  const history = [
    system({ content: "You are a bot.", toolsAdded: [tool("bash")] }),
    piUser(piText("first")),
    piSaid(piText("A reply.")),
    piUser(piText("second")),
    piSaid(piThinking("Nothing to say.")),
    system({ toolsAdded: [tool("search")] }),
    piUser(piText("third")),
    piSaid(piText("Another reply.")),
    piUser(piText("fourth")),
  ];
  const frames = framesOf(history);
  expect(shape(frames)).toEqual(["user: first", "assistant: A reply.", "user: second | third", "assistant: Another reply.", "user: fourth"]);
  // "search" arrives before the second reply that is sent: the request's assistant message 1, not 2.
  const plan = prepareNativeTranscript(prepareMessages(history as any, OPUS), true)!;
  expect(plan.systemInjections.map((i) => i.beforeAssistant)).toEqual([1]);
});

test("a tool call that never got a result is answered with an error result, before the next message's content", () => {
  // The production 400: the run was stopped while `bash` ran, and the next message came after.
  const history = [
    piUser(piText(NOTICE(1))),
    piSaid(piThinking("Look at the logs."), piCall("toolu_019xgC")),
    piUser(piText(NOTICE(2)), piImage()),
  ];
  const frames = framesOf(history);
  expect(shape(frames)).toEqual([`user: ${NOTICE(1)}`, "assistant: thinking | call toolu_019xgC", `user: result toolu_019xgC (error) | ${NOTICE(2)} | image`]);
  expect(frames[2]!.message.content[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_019xgC", content: MISSING_TOOL_RESULT, is_error: true });
  // One of two answered: the other gets its result beside it, ahead of the notice.
  expect(shape(framesOf([piUser(piText("first")), piSaid(piCall("toolu_a"), piCall("toolu_b")), piResult("toolu_b", "done"), piUser(piText("second"))]))).toEqual([
    "user: first",
    "assistant: call toolu_a | call toolu_b",
    "user: result toolu_b | result toolu_a (error) | second",
  ]);
  // Answered calls are left alone, and a call followed by another reply gets a message for its result.
  const answered = [piUser(piText("first")), piSaid(piCall("toolu_a")), piResult("toolu_a", "done"), piSaid(piText("ok")), piUser(piText("second"))];
  expect(shape(framesOf(answered))).toEqual(["user: first", "assistant: call toolu_a", "user: result toolu_a", "assistant: ok", "user: second"]);
  const between = framesOf([piUser(piText("first")), piSaid(piCall("toolu_a")), piSaid(piText("carried on")), piUser(piText("second"))]);
  expect(shape(between)).toEqual(["user: first", "assistant: call toolu_a", "user: result toolu_a (error)", "assistant: carried on", "user: second"]);
  expect(between.map((f) => f.shouldQuery)).toEqual([false, undefined, false, undefined, undefined]);
});

// The request Claude Code 2.1 builds, as captured from the real binary: its environment message after
// the first user message, the date at the tail, and its own additions inside user messages.
const wireText = (text: string, extra: Record<string, unknown> = {}) => ({ type: "text", text, ...extra });
const wireResult = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content, is_error: false });
const wireCall = (id: string) => ({ type: "tool_use", id, name: "mcp__pi__bash", input: { command: "gh pr view" } });
const ENVIRONMENT = { role: "system", content: "# Environment\nYou have been invoked in the following environment: …" };
const DATE = { role: "system", content: [wireText("Today's date is 2026-11-15.", { cache_control: { type: "ephemeral" } })] };
const NUDGE = "[Your previous response had no visible output. Please continue and produce a user-visible response.]\n";
const frame = (type: "user" | "assistant", ...content: unknown[]): NativeFrame => ({ type, message: { role: type, content } });
const rewritten = (messages: unknown[], frames: NativeFrame[], injections?: { beforeAssistant: number | null; content: Record<string, unknown>[] }[]) =>
  JSON.parse(rewriteInitialRequest(Buffer.from(JSON.stringify({ system: [], messages })), frames, undefined, injections).toString()).messages as { role: string; content: any[] }[];
const withoutMarkers = (content: any[]) => content.map(({ cache_control, ...block }) => block);

test("user messages Claude Code joined are filled from each of Pi's they hold, and what it added is dropped", () => {
  // The production failure, "22 user messages where Pi's history has 23", in small. A process that is
  // carried on in after its own reply with no visible output has dropped that reply, kept the line it
  // asked itself for a visible one with, and joined the next notice to the tool results before it.
  const frames = [
    frame("user", wireText(SUMMARY)),
    frame("assistant", wireText("The connectors plan is complete.")),
    frame("user", wireText(NOTICE(1))),
    frame("assistant", wireCall("toolu_a"), wireCall("toolu_b")),
    frame("user", wireResult("toolu_a", "Sent as [fc7fb3de]"), wireResult("toolu_b", "Sent as [803cbe02]")),
    frame("assistant", { type: "thinking", thinking: "Both sent.", signature: "c2lnbmF0dXJl" }),
    frame("user", wireText(NOTICE(2)), { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } }),
  ];
  const native = [
    { role: "user", content: [wireText(SUMMARY)] },
    ENVIRONMENT,
    { role: "assistant", content: [wireText("The connectors plan is complete.")] },
    { role: "user", content: [wireText(NOTICE(1))] },
    { role: "assistant", content: [wireCall("toolu_a"), wireCall("toolu_b")] },
    {
      role: "user",
      content: [
        // Claude Code also appends to tool results; Pi's text is what is sent.
        wireResult("toolu_a", "Sent as [fc7fb3de]\n<system-reminder>native</system-reminder>"),
        wireResult("toolu_b", "Sent as [803cbe02]"),
        wireText(NUDGE),
        wireText(NOTICE(2)),
        { type: "image", source: { type: "base64", media_type: "image/png", data: "c21hbGxlcg==" } },
        wireText("[Image: original 2000x1000, displayed at 1000x500. Multiply coordinates by 2.]", { cache_control: { type: "ephemeral" } }),
      ],
    },
    DATE,
  ];
  const output = rewritten(native, frames);
  expect(output.map((m) => m.role)).toEqual(["user", "system", "assistant", "user", "assistant", "user", "system"]);
  expect(withoutMarkers(output[5]!.content)).toEqual([
    { ...wireResult("toolu_a", "Sent as [fc7fb3de]") },
    { ...wireResult("toolu_b", "Sent as [803cbe02]") },
    wireText(NOTICE(2)),
    // Claude Code's downscaled copy of the image, and its note on the scale, as in any other message.
    { type: "image", source: { type: "base64", media_type: "image/png", data: "c21hbGxlcg==" } },
    wireText("[Image: original 2000x1000, displayed at 1000x500. Multiply coordinates by 2.]"),
  ]);
  expect(JSON.stringify(output)).not.toContain("no visible output");
  // Its cache breakpoint stays on the message.
  expect(output[5]!.content.at(-1).cache_control).toEqual({ type: "ephemeral" });
  expect(withoutMarkers(output[3]!.content)).toEqual([wireText(NOTICE(1))]);
});

test("several joined messages in one request, and text Claude Code ended with a newline when it joined", () => {
  const frames = [
    frame("user", wireText("first")),
    frame("assistant", { type: "thinking", thinking: "one", signature: "c2ln" }),
    frame("user", wireText("second"), wireText("a second block")),
    frame("assistant", { type: "thinking", thinking: "two", signature: "c2ln" }),
    frame("user", wireText("third")),
    frame("assistant", wireText("A reply.")),
    frame("user", wireText("fourth")),
    frame("assistant", { type: "thinking", thinking: "three", signature: "c2ln" }),
    frame("user", wireText("fifth")),
  ];
  const native = [
    { role: "user", content: [wireText("first\n"), wireText(NUDGE), wireText("second"), wireText("a second block\n"), wireText(NUDGE), wireText("third")] },
    ENVIRONMENT,
    { role: "assistant", content: [wireText("A reply.")] },
    { role: "user", content: [wireText("fourth\n"), wireText(NUDGE), wireText("fifth")] },
    DATE,
  ];
  const output = rewritten(native, frames);
  expect(withoutMarkers(output[0]!.content)).toEqual([wireText("first"), wireText("second"), wireText("a second block"), wireText("third")]);
  expect(withoutMarkers(output[3]!.content)).toEqual([wireText("fourth"), wireText("fifth")]);

  // A tool change Pi placed before a reply the request doesn't have goes before the next one that is
  // there, or at the tail when none is.
  const change = (name: string) => [{ type: "tool_addition", tool: { type: "tool_reference", name } }];
  const injected = rewritten(native, frames, [
    { beforeAssistant: 1, content: change("mcp__pi__one") },
    { beforeAssistant: 2, content: change("mcp__pi__two") },
    { beforeAssistant: 3, content: change("mcp__pi__three") },
    { beforeAssistant: null, content: change("mcp__pi__four") },
  ]);
  const order = injected.map((m) => (m.role === "system" && Array.isArray(m.content) && m.content[0]?.tool ? m.content[0].tool.name.slice(9) : m.role));
  expect(order).toEqual(["user", "system", "one", "two", "assistant", "user", "system", "three", "four"]);
});

test("a history that can't be placed in the request still fails it, and nothing is moved to another message", () => {
  const frames = [
    frame("user", wireText("first")),
    frame("assistant", { type: "thinking", thinking: "one", signature: "c2ln" }),
    frame("user", wireText("second")),
    frame("assistant", wireCall("toolu_a")),
    frame("user", wireResult("toolu_a", "done"), wireText("third")),
  ];
  const reply = { role: "assistant", content: [wireCall("toolu_a")] };
  const tail = { role: "user", content: [wireResult("toolu_a", "done"), wireText("third")] };
  // As Claude Code joins them: placed.
  expect(rewritten([{ role: "user", content: [wireText("first\n"), wireText(NUDGE), wireText("second")] }, reply, tail], frames).length).toBe(3);
  // Pi's second message isn't in the joined one (other text, or missing): refused, as before.
  for (const joined of [[wireText("first\n"), wireText("something else")], [wireText("first")], [wireText("second"), wireText("first")]]) {
    expect(() => rewritten([{ role: "user", content: joined }, reply, tail], frames)).toThrow(/2 user messages where Pi's history has 3/);
  }
  // A frame is never taken from the message it belongs to, to fill an earlier one that looks alike.
  const alike = [frame("user", wireText("ping")), frame("assistant", { type: "thinking", thinking: "one", signature: "c2ln" }), frame("user", wireText("ping")), frame("assistant", wireText("pong")), frame("user", wireText("ping"))];
  const placed = rewritten([{ role: "user", content: [wireText("ping\n"), wireText(NUDGE), wireText("ping")] }, { role: "assistant", content: [wireText("pong")] }, { role: "user", content: [wireText("ping")] }], alike);
  expect(placed.map((m) => m.content.length)).toEqual([2, 1, 1]);
  // A user message of Claude Code's own, one more than Pi has, is refused too.
  expect(() => rewritten([{ role: "user", content: [wireText("first")] }, { role: "user", content: [wireText("extra")] }], [frame("user", wireText("first"))])).toThrow(/2 user messages where Pi's history has 1/);
  // With as many messages as Pi has, a tool result in the wrong one is still caught.
  const shifted = [frame("user", wireText("first")), frame("assistant", wireCall("toolu_a")), frame("user", wireResult("toolu_a", "done"))];
  expect(() => rewritten([{ role: "user", content: [wireText("first")] }, reply, { role: "user", content: [wireText("(no content)")] }], shifted)).toThrow(/lost a tool_result block/);
});

/**
 * A Claude Code that sends its requests through the bridge's relay and keeps its own history, as the
 * real one does: user messages in a row are one message, and a reply with no visible output is
 * dropped, with a line asking for a visible one in its place and a second request (which the relay
 * refuses). With DRIFT set, a process that has answered once has a user message Pi never sent.
 */
const RELAY_CLI = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })); process.exit(0); }
const out = (v) => console.log(JSON.stringify(v));
const usage = { input_tokens: 3, output_tokens: 1 };
const history = [];
let answered = 0;
const messages = () => {
  const joined = [];
  for (const m of history) {
    const last = joined.at(-1);
    if (m.role === "user" && last?.role === "user") last.content.push(...m.content);
    else joined.push({ role: m.role, content: [...m.content] });
  }
  return joined;
};
const send = async () => {
  const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: [], messages: messages() }) });
  return { ok: response.ok, text: await response.text() };
};
(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    const echo = frame.uuid ? { user_message_uuids: [frame.uuid] } : {};
    if (process.env.DRIFT && answered > 0 && frame.type === "user") history.push({ role: "user", content: [{ type: "text", text: "a message Pi never sent" }] });
    history.push({ role: frame.message.role, content: frame.message.content });
    if (frame.shouldQuery === false) { out({ type: "result", num_turns: 0, ...echo }); continue; }
    if (frame.type !== "user") continue;
    appendFileSync(process.env.LAUNCH_LOG, JSON.stringify({ pid: process.pid }) + "\\n");
    const reply = await send();
    answered += 1;
    if (!reply.ok) { out({ type: "result", subtype: "error_during_execution", is_error: true, usage, ...echo }); continue; }
    if (reply.text.includes("text_delta")) history.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    else {
      history.push({ role: "user", content: [{ type: "text", text: "[Your previous response had no visible output. Please continue and produce a user-visible response.]" }] });
      await send();
    }
    out({ type: "result", subtype: "success", is_error: false, usage, ...echo });
  }
})();
`;

test("a reply with no visible output isn't carried on from, and a request that can't be rewritten is replayed in a new process", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-claude-replay-"));
  try {
    const cli = join(root, "claude");
    writeFileSync(cli, RELAY_CLI);
    chmodSync(cli, 0o755);
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from "node:assert";
      import { readFileSync } from "node:fs";
      import { createServer } from "node:http";
      const bridge = await import("./server/bots/claude-code/claude-cli.ts");

      // The API: thinking alone when the last message asks for it, else "ok". It keeps what it was sent.
      const sent = [];
      const usage = { input_tokens: 3, output_tokens: 1 };
      const sse = (events) => events.map((e) => "event: " + e.type + "\\ndata: " + JSON.stringify(e) + "\\n\\n").join("");
      const api = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        sent.push(body.messages);
        const thinking = JSON.stringify(body.messages.at(-1).content.at(-1)).includes("THINK");
        response.writeHead(200, { "content-type": "text/event-stream" }).end(sse([
          { type: "message_start", message: { id: "msg_1", role: "assistant", content: [], stop_reason: null, usage } },
          { type: "content_block_start", index: 0, content_block: thinking ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: thinking ? { type: "thinking_delta", thinking: "Nothing to say." } : { type: "text_delta", text: "ok" } },
          ...(thinking ? [{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2ln" } }] : []),
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
          { type: "message_stop" },
        ]));
      });
      await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
      const upstreamUrl = "http://127.0.0.1:" + api.address().port;

      const env = { PI_CLAUDE_CODE_COMMAND: ${JSON.stringify(cli)}, CLAUDE_CONFIG_DIR: ${JSON.stringify(root)} };
      const past = (frame) => (frame.type === "user" ? { ...frame, shouldQuery: false } : frame);
      const text = (value) => ({ type: "text", text: value });
      const user = (...values) => ({ type: "user", message: { role: "user", content: values.map(text) } });
      const said = (...content) => ({ type: "assistant", message: { role: "assistant", content } });
      const ask = (frames, extra = {}) => bridge.runClaudeRequest({ model: "sonnet", frames: [...frames.slice(0, -1).map(past), frames.at(-1)], systemPrompt: "system", manifest: [], extraBody: {}, env, upstreamUrl, ...extra });
      const pids = () => readFileSync(process.env.LAUNCH_LOG, "utf8").trim().split("\\n").map((l) => JSON.parse(l).pid);
      const texts = (messages) => messages.map((m) => m.role + ": " + m.content.map((b) => b.text ?? b.type).join(" | "));

      // A reply with thinking and nothing else. Its process has asked itself for a visible one and
      // keeps that line: it is closed, not kept for the next request.
      const thought = await ask([user("THINK about it")], { sessionId: "one" });
      a.deepEqual(thought.message.content.map((b) => b.type), ["thinking"]);
      a.equal(thought.relay.blockedRequests, 1);
      a.equal(bridge.cachedClaudeProcessCount(), 0);
      // The next request, as Pi's history is replayed now: the reply left out, both messages in one.
      a.equal((await ask([user("THINK about it", "and then?")], { sessionId: "one" })).message.content[0].text, "ok");
      a.deepEqual(texts(sent.at(-1)), ["user: THINK about it | and then?"]);
      a.notEqual(pids()[1], pids()[0]);
      // And with the reply still in the history, which the closed process would have carried on from.
      await bridge.closeClaudeProcesses();
      await ask([user("THINK twice")], { sessionId: "two" });
      const before = pids().length;
      const reply = said({ type: "thinking", thinking: "Nothing to say.", signature: "c2ln" });
      a.equal((await ask([user("THINK twice"), reply, user("and then?")], { sessionId: "two" })).message.content[0].text, "ok");
      a.notEqual(pids()[before], pids()[before - 1]);
      a.ok(!JSON.stringify(sent).includes("no visible output"), "Claude Code's own line reached the API");

      // A process that is carried on in, with a history Pi's can't be placed in: the request is never
      // sent, and is replayed in a new process instead of failing the turn.
      await bridge.closeClaudeProcesses();
      const drift = { sessionId: "three", env: { ...env, DRIFT: "1" } };
      a.equal((await ask([user("hello")], drift)).message.content[0].text, "ok");
      a.equal(bridge.cachedClaudeProcessCount(), 1);
      const requests = sent.length;
      const start = pids().length;
      const again = await ask([user("hello"), said(text("ok")), user("again")], drift);
      a.equal(again.message.content[0].text, "ok");
      a.equal(sent.length, requests + 1);
      a.deepEqual(texts(sent.at(-1)), ["user: hello", "assistant: ok", "user: again"]);
      // Tried where it was carried on (the first process of the three), answered in a new one.
      a.deepEqual([pids()[start] === pids()[start - 1], pids()[start + 1] === pids()[start]], [true, false]);

      await bridge.closeClaudeProcesses();
      api.close();
      process.exit(0);
    `, { HOME: root, LAUNCH_LOG: join(root, "launches.jsonl") });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

// ------------------------------------------------------------------ a process on standby for the request after a tool call

/** A Claude Code that answers "TOOL" with a tool call and anything else with text, and says which process answered. */
const STANDBY_CLI = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })); process.exit(0); }
const note = (event) => appendFileSync(process.env.LAUNCH_LOG, JSON.stringify({ pid: process.pid, event }) + "\\n");
note("start");
const out = (v) => console.log(JSON.stringify(v));
const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    const echo = frame.uuid ? { user_message_uuids: [frame.uuid] } : {};
    if (frame.shouldQuery === false) { out({ type: "result", num_turns: 0, ...echo }); continue; }
    if (frame.type !== "user") continue;
    note("query");
    const tool = JSON.stringify(frame.message.content).includes("TOOL");
    const block = tool ? { type: "tool_use", id: "toolu_1", name: "mcp__pi__probe", input: {} } : { type: "text", text: "ok" };
    const stop = tool ? "tool_use" : "end_turn";
    for (const event of [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: tool ? block : { type: "text", text: "" } },
      ...(tool ? [] : [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }]),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: stop }, usage },
      { type: "message_stop" },
    ]) out({ type: "stream_event", event });
    out({ type: "assistant", message: { id: "m1", role: "assistant", content: [block], stop_reason: stop, usage } });
    out({ type: "result", subtype: "success", is_error: false, usage, ...echo });
  }
})();
`;

test("the request after a tool call runs in a process started ahead of it, and nothing is left running", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-claude-standby-"));
  try {
    const cli = join(root, "claude");
    writeFileSync(cli, STANDBY_CLI);
    chmodSync(cli, 0o755);
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from "node:assert";
      import { readFileSync } from "node:fs";
      const bridge = await import("./server/bots/claude-code/claude-cli.ts");
      const env = { PI_CLAUDE_CODE_COMMAND: ${JSON.stringify(cli)}, CLAUDE_CONFIG_DIR: ${JSON.stringify(root)} };
      const manifest = [{ name: "probe", description: "A probe", inputSchema: { type: "object", properties: {} } }];
      const past = (frame) => ({ ...frame, shouldQuery: false });
      const user = (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
      const called = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__pi__probe", input: {} }] } };
      const said = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
      const result = (text) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] } });
      const ask = (frames, extra = {}) => bridge.runClaudeRequest({ model: "sonnet", frames: [...frames.slice(0, -1).map(past), frames.at(-1)], systemPrompt: "system", manifest, extraBody: {}, env, sessionId: "one", ...extra });
      const log = () => readFileSync(process.env.LAUNCH_LOG, "utf8").trim().split("\\n").filter(Boolean).map((l) => JSON.parse(l));
      const started = () => log().filter((l) => l.event === "start").map((l) => l.pid);
      const answered = () => log().filter((l) => l.event === "query").map((l) => l.pid);
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      // Started, still running, and never asked anything: a standby. (One closed before it was up may never have logged its start.)
      const waitingProcesses = () => started().filter((pid) => alive(pid) && !answered().includes(pid));
      const until = async (check, what) => { for (let i = 0; i < 1500 && !check(); i++) await Bun.sleep(10); a.ok(check(), what); };
      const steps = () => readFileSync(process.env.PI_CLAUDE_CODE_TRACE, "utf8").trim().split("\\n").map((l) => JSON.parse(l)).filter((s) => s.step === "acquired").map((s) => (s.continuation ? "same" : s.standby ? "standby" : "new"));

      // The first request starts its own process, and one more for whatever comes next.
      const history = [user("TOOL please")];
      a.equal((await ask(history)).message.content[0].type, "tool_use");
      await until(() => started().length === 2, "no standby was started");
      a.equal(bridge.standbyClaudeProcessCount(), 1);
      const [first, second] = started();
      a.deepEqual(answered(), [first]);

      // It ended in a tool call, so the next one can't carry on there: the standby answers, and is replaced.
      history.push(called, result("TOOL again"));
      a.equal((await ask(history)).message.content[0].type, "tool_use");
      a.deepEqual(answered(), [first, second]);
      await until(() => started().length === 3, "the standby wasn't replaced");
      const third = started()[2];

      // The run ends without a tool call: its process is kept for the next request, and no standby waits beside it.
      history.push(called, result("finish"));
      a.equal((await ask(history)).message.content[0].text, "ok");
      a.deepEqual(answered(), [first, second, third]);
      await until(() => bridge.standbyClaudeProcessCount() === 0, "a standby was left beside a retained process");
      a.equal(bridge.cachedClaudeProcessCount(), 1);
      history.push(said, user("TOOL once more"));
      await ask(history);
      a.deepEqual(answered(), [first, second, third, third]);
      a.deepEqual(steps(), ["new", "standby", "standby", "same"]);

      // A standby is for one launch: a request with another system prompt starts its own.
      await until(() => bridge.standbyClaudeProcessCount() === 1 && waitingProcesses().length === 1, "no standby after the fourth request");
      const [waiting] = waitingProcesses();
      history.push(called, result("TOOL with new instructions"));
      await ask(history, { systemPrompt: "other system" });
      a.notEqual(answered().at(-1), waiting);
      a.equal(steps().at(-1), "new");
      await until(() => !alive(waiting), "the standby for the old launch was left running");

      // One that died while it waited is passed over, and the request is still answered.
      await until(() => bridge.standbyClaudeProcessCount() === 1 && waitingProcesses().length === 1, "no standby after the fifth request");
      const [doomed] = waitingProcesses();
      process.kill(doomed, "SIGKILL");
      await until(() => !alive(doomed), "couldn't stop the standby");
      history.push(called, result("TOOL after the standby died"));
      a.equal((await ask(history, { systemPrompt: "other system" })).message.content[0].type, "tool_use");
      a.notEqual(answered().at(-1), doomed);

      // Switched off, every request after a tool call starts its own process, as it used to.
      await bridge.closeClaudeProcesses();
      a.equal(bridge.standbyClaudeProcessCount(), 0);
      const off = { env: { ...env, PI_CLAUDE_CODE_STANDBY: "0" }, sessionId: "two" };
      await until(() => !waitingProcesses().length, "a standby outlived its session");
      const before = started().length;
      await ask([user("TOOL please")], off);
      await ask([user("TOOL please"), called, result("TOOL again")], off);
      await Bun.sleep(300);
      a.equal(started().length, before + 2);
      a.equal(bridge.standbyClaudeProcessCount(), 0);
      a.deepEqual(steps().slice(-2), ["new", "new"]);
      // A request that declares no tools can't end in a tool call, so nothing is started ahead for it.
      await ask([user("hello")], { manifest: [], sessionId: "three" });
      await Bun.sleep(300);
      a.equal(bridge.standbyClaudeProcessCount(), 0);

      // With the sessions closed, no process is left.
      await bridge.closeClaudeProcesses();
      await until(() => started().every((pid) => !alive(pid)), "a claude process outlived its session: " + started().filter(alive));
      a.equal(bridge.cachedClaudeProcessCount(), 0);
      process.exit(0);
    `, { HOME: root, LAUNCH_LOG: join(root, "launches.jsonl"), PI_CLAUDE_CODE_TRACE: join(root, "trace.jsonl") });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
