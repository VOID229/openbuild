import { expect, test } from "bun:test";
import { codexDetection, codexModelAccount, deviceDetection } from "../src/lib/store";
import type { ModelInfo, RuntimeAccount } from "../shared/types";
import type { Detection } from "../src/lib/types";

test("Codex provider selection resolves the login on the right device and locks started threads", () => {
 const model = (provider: string) => ({ id: `${provider}/native-model`, provider, name: "Native model" }) as ModelInfo;
 const account: RuntimeAccount = { id: "codex2", name: "codex2", runtime: "codex", configDir: "/tmp/account2" };
 const list = { plan: "codex", status: "valid", models: [model("codex")], accounts: [{ account, models: [model("codex2")] }] } as Detection & { accounts: { account: RuntimeAccount; models: ModelInfo[] }[] };
 const state = { detection: {}, codexModels: { remote: list } };
 expect(deviceDetection(state, "remote", "codex").codex?.models.map((m) => m.id)).toEqual(["codex/native-model", "codex2/native-model"]);
 expect(codexModelAccount(state, "remote", "codex2/native-model")).toEqual({ ...account, deviceId: "remote" });
 expect(codexModelAccount(state, undefined, "codex2/native-model")).toBeUndefined();
 expect(codexModelAccount(state, "remote", "codex/native-model")).toBeUndefined();
 expect(codexDetection(list)).toBe(codexDetection(list));
 const messages = [{ id: "turn" }] as any;
 expect(codexDetection(list, { messages }).models.map((m) => m.provider)).toEqual(["codex"]);
 expect(codexDetection(list, { messages, runtimeAccount: account }).models.map((m) => m.provider)).toEqual(["codex2"]);
 expect(codexDetection(list, { messages, runtimeAccount: { ...account, id: "old-uuid" } }).models.map((m) => m.provider)).toEqual(["codex2"]);
 expect(codexDetection(list, { messages, runtimeAccount: { ...account, id: "missing", configDir: "/gone" } }).models).toEqual([]);
});


test("Codex discovers signed-in siblings and reconciles the older numeric home spelling", async () => {
 const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
 const { join } = await import("node:path");
 const { tmpdir } = await import("node:os");
 const { codexAccounts } = await import("../server/codex/accounts");
 const home = mkdtempSync(join(tmpdir(), "codex-accounts-"));
 try {
  for (const n of [2, 3, 10]) { const dir = join(home, `.codex-${n}`); mkdirSync(dir); writeFileSync(join(dir, "auth.json"), "{}"); }
  mkdirSync(join(home, ".codex-4"));
  const saved = [{ name: "codex2", configDir: "~/.codex2" }];
  expect(codexAccounts(saved, home).map((a) => [a.id, a.configDir])).toEqual([2, 3, 10].map((n) => [`codex${n}`, join(home, `.codex-${n}`)]));
  // An explicit existing home must never be silently replaced by another account.
  mkdirSync(join(home, ".codex2"));
  expect(codexAccounts(saved, home)[0]?.configDir).toBe(join(home, ".codex2"));
 } finally { rmSync(home, { recursive: true, force: true }); }
});
