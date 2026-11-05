import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "../server/claude/install";
import { accountArgs, accountBin, accountEnvironment, accountPath, shareHome, splitArgs, withRuntimeAccount } from "../server/runtimeAccounts";
import type { PiChatRequest } from "../shared/types";
const req = (path: string, runtime = "codex") => ({ runtime, runtimeAccount: { id: path, name: path, runtime, configDir: path } }) as PiChatRequest;
test("parallel asynchronous turns retain independent account environments", async () => {
  const base = { OPENAI_API_KEY: "ambient", PATH: "/bin", CODEX_HOME: "/default" };
  const results = await Promise.all(["/work", "/personal"].map((path) => withRuntimeAccount(req(path), async () => {
    await new Promise((r) => setTimeout(r, path === "/work" ? 15 : 1));
    return accountEnvironment("codex", base);
  })));
  expect(results.map((r) => r.CODEX_HOME)).toEqual(["/work", "/personal"]);
  expect(results.every((r) => !r.OPENAI_API_KEY && r.PATH === "/bin")).toBe(true);
  expect(accountEnvironment("codex", base)).toBe(base);
  expect(base.OPENAI_API_KEY).toBe("ambient");
});
test("runtime mismatch and invalid paths are rejected before starting work", () => {
  expect(() => withRuntimeAccount({ ...req("/work"), runtime: "cursor" }, () => 1)).toThrow("match");
  expect(() => accountPath("relative/path")).toThrow("absolute");
  expect(() => accountPath("/a\0b")).toThrow("Invalid");
  expect(accountPath("~/work")).toEndWith("/work");
});
test("each runtime receives only its own account override", () => {
  withRuntimeAccount(req("/claude-work", "claude"), () => {
    expect(accountEnvironment("claude", { ANTHROPIC_API_KEY: "ambient" })).toEqual({ CLAUDE_CONFIG_DIR: "/claude-work" });
    expect(accountEnvironment("cursor", { CURSOR_CONFIG_DIR: "/default" })).toEqual({ CURSOR_CONFIG_DIR: "/default" });
  });
});
test("launch arguments keep quoted words whole", () => {
  expect(splitArgs(`--a "b c" --d='e f' g`)).toEqual(["--a", "b c", "--d=e f", "g"]);
});
test("account options reach only their own runtime", () => {
  const account = { id: "a", name: "a", runtime: "claude", configDir: "/x", launchArgs: "--chrome --max 2", autoCompactWindow: 300000, binPath: process.execPath } as const;
  withRuntimeAccount({ runtime: "claude", runtimeAccount: account } as PiChatRequest, () => {
    expect(claudeArgs()).toEqual({ chrome: null, max: "2" });
    expect(accountEnvironment("claude", {}).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("300000");
    expect(accountBin("claude", "")).toBe(process.execPath);
    expect(accountBin("codex", "")).toBeUndefined();
    expect(accountArgs("codex")).toEqual([]);
  });
  const run = (patch: object) => () => withRuntimeAccount({ runtime: "claude", runtimeAccount: { ...account, ...patch } } as PiChatRequest, () => 1);
  expect(run({ autoCompactWindow: 5 })).toThrow("Auto-compact");
  expect(run({ shadowHome: "/y" })).toThrow("Codex");
  expect(withRuntimeAccount({ runtime: "claude", runtimeAccount: { ...account, launchArgs: "bare" } } as PiChatRequest, () => { try { claudeArgs(); } catch (e) { return (e as Error).message; } })).toContain("--flags");
  expect(withRuntimeAccount({ runtime: "claude", runtimeAccount: { ...account, binPath: "/no/such/bin" } } as PiChatRequest, () => accountBin("claude", ""))).toBe("");
});
test("a shadow home shares everything but the sign-in", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-shadow-"));
  const home = join(root, "home"), shadow = join(root, "shadow");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "auth.json"), "main");
  writeFileSync(join(home, "config.toml"), "x");
  const gone = join(home, "gone.txt");
  writeFileSync(gone, "");
  shareHome(home, shadow);
  writeFileSync(join(shadow, "auth.json"), "alt");
  rmSync(gone);
  shareHome(home, shadow);
  expect(readdirSync(shadow).sort()).toEqual(["auth.json", "config.toml", "sessions"]);
  expect(readFileSync(join(shadow, "auth.json"), "utf8")).toBe("alt");
  expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("main");
  expect(lstatSync(join(shadow, "sessions")).isSymbolicLink()).toBe(true);
  const dir = withRuntimeAccount({ runtime: "codex", runtimeAccount: { id: "a", name: "a", runtime: "codex", configDir: home, shadowHome: shadow } } as PiChatRequest, () => accountEnvironment("codex", {}).CODEX_HOME);
  expect(dir).toBe(shadow);
});
test("an Ori account runs its harness through a shim that passes every argument on", async () => {
  const root = mkdtempSync(join(tmpdir(), "ori-shim-"));
  const env = { ORI_BIN: process.env.ORI_BIN, OPENCHAT_DATA_DIR: process.env.OPENCHAT_DATA_DIR };
  const ori = join(root, "ori"), real = join(root, "bin", "claude");
  mkdirSync(join(root, "bin"));
  writeFileSync(ori, `#!/bin/sh\nprintf '%s\\n' "$PATH" "$@"\n`, { mode: 0o755 });
  writeFileSync(real, "", { mode: 0o755 });
  process.env.ORI_BIN = ori;
  process.env.OPENCHAT_DATA_DIR = join(root, "data");
  try {
    const account = { id: "o", name: "claude-ori", runtime: "claude", configDir: "/x", ori: true } as const;
    const shim = withRuntimeAccount({ runtime: "claude", runtimeAccount: account } as PiChatRequest, () => accountBin("claude", ""))!;
    expect(shim.startsWith(join(root, "data", "ori"))).toBe(true);
    expect(withRuntimeAccount({ runtime: "claude", runtimeAccount: account } as PiChatRequest, () => accountBin("claude", ""))).toBe(shim);
    const chosen = withRuntimeAccount({ runtime: "claude", runtimeAccount: { ...account, binPath: real } } as PiChatRequest, () => accountBin("claude", ""))!;
    const p = Bun.spawn([chosen, "--print", "a b"], { stdout: "pipe", env: { PATH: "/usr/bin:/bin" } });
    expect((await new Response(p.stdout).text()).split("\n")).toEqual([`${join(root, "bin")}:/usr/bin:/bin`, "claude", "--", "--print", "a b", ""]);
    expect(withRuntimeAccount({ runtime: "claude", runtimeAccount: { ...account, binPath: "/no/such/bin" } } as PiChatRequest, () => accountBin("claude", ""))).toBe("");
    expect(() => withRuntimeAccount({ runtime: "cursor", runtimeAccount: { ...account, runtime: "cursor" } } as PiChatRequest, () => 1)).toThrow("Ori");
    process.env.ORI_BIN = join(root, "missing");
    expect(() => withRuntimeAccount({ runtime: "codex", runtimeAccount: { ...account, runtime: "codex" } } as PiChatRequest, () => accountBin("codex", ""))).toThrow("Ori isn't installed");
  } finally {
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
