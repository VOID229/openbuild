import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAccounts, detectAccounts } from "../server/claude/accounts";
import { claudeDetection } from "../src/lib/store";
import type { Detection } from "../src/lib/types";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
  mkdirSync(join(dir, ".claude"));
  mkdirSync(join(dir, "bin"));
  return dir;
}
const wrapper = (dir: string, name: string, line: string) => {
  writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${line}\nexec claude "$@"\n`);
  chmodSync(join(dir, "bin", name), 0o755);
};

test("finds wrappers, aliases and signed-in siblings in numeric order", () => {
  const dir = home();
  for (const name of [".claude-2", ".claude-3", ".claude-10", ".claude-empty", ".claude-work"]) mkdirSync(join(dir, name));
  wrapper(dir, "claude2", 'export CLAUDE_CONFIG_DIR="$HOME/.claude-2"');
  writeFileSync(join(dir, ".zshrc"), "alias claude3='CLAUDE_CONFIG_DIR=~/.claude-3 claude'\n");
  writeFileSync(join(dir, ".claude-10", ".credentials.json"), "{}");
  writeFileSync(join(dir, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: {} }));
  expect(detectAccounts(dir, join(dir, "bin")).map((a) => [a.id, a.configDir.slice(dir.length)])).toEqual([
    ["claude-work", "/.claude-work"], ["claude2", "/.claude-2"], ["claude3", "/.claude-3"], ["claude10", "/.claude-10"],
  ].sort((a, b) => a[0]!.localeCompare(b[0]!, undefined, { numeric: true })));
});

test("a wrapper for the default directory or a missing one is no account", () => {
  const dir = home();
  wrapper(dir, "claude2", `CLAUDE_CONFIG_DIR=${join(dir, ".claude")}`);
  wrapper(dir, "claude3", "CLAUDE_CONFIG_DIR=$HOME/.gone");
  expect(detectAccounts(dir, join(dir, "bin"))).toEqual([]);
});

test("a saved account names the directory detection also found", () => {
  const dir = home();
  mkdirSync(join(dir, ".claude-2"));
  wrapper(dir, "claude2", "CLAUDE_CONFIG_DIR=$HOME/.claude-2");
  const accounts = claudeAccounts([{ name: "Work", configDir: join(dir, ".claude-2") }, { name: "bad", configDir: "relative" }], dir, join(dir, "bin"));
  expect(accounts.map((a) => a.id)).toEqual(["work"]);
});

test("a started thread lists only its own account's models", () => {
  const model = (id: string, provider: string) => ({ id, name: id, provider }) as any;
  const list = { plan: "claude", status: "valid", models: [model("claude/opus", "claude")], accounts: [{ account: { id: "claude2", name: "claude2", runtime: "claude", configDir: "/x" }, models: [model("claude2/opus", "claude2")] }] } as unknown as Detection;
  const ids = (chat?: any) => claudeDetection(list, chat).models.map((m) => m.id);
  const turn = [{ id: "1" }];
  expect(ids()).toEqual(["claude/opus", "claude2/opus"]);
  expect(ids({ messages: [] })).toEqual(["claude/opus", "claude2/opus"]);
  expect(ids({ messages: turn })).toEqual(["claude/opus"]);
  expect(ids({ messages: turn, runtimeAccount: { id: "claude2" } })).toEqual(["claude2/opus"]);
  expect(ids({ messages: turn, runtimeAccount: { id: "gone" } })).toEqual(["claude/opus"]);
  expect(claudeDetection(list)).toBe(claudeDetection(list));
});
