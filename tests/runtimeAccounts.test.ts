import { expect, test } from "bun:test";
import { accountEnvironment, accountPath, withRuntimeAccount } from "../server/runtimeAccounts";
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
