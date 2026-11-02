// Read-only findings: expected-failing invariants preserve offline reproductions without changing
// storage.ts or convex/sync.ts. Remove `.failing` when those areas' owners implement the fixes.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appTest } from "./convex";
import { api } from "../convex/_generated/api";

describe("transport audit: read-only persistence findings", () => {
  let storedMessages: string[];
  let currentFileExists: boolean;
  let currentDraftFileExists: boolean;

  beforeAll(async () => {
    // Never import storage in this process: that could open a user's actual SQLite database.
    const dir = await mkdtemp(join(tmpdir(), "openbuild-transport-audit-"));
    try {
      const script = `
        const s = await import("./server/storage.ts");
        const prompt = {id:"user",role:"user",content:"prompt"};
        const reply = {id:"assistant",role:"assistant",content:"finished reply"};
        s.putChat({id:"audit",createdAt:1,updatedAt:200,messages:[prompt,reply]});
        s.putChat({id:"audit",createdAt:1,updatedAt:100,messages:[prompt]});
        console.log(JSON.stringify(s.getChat("audit").messages.map(m => m.content)));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, OPENCHAT_DATA_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0);
      expect(err).toBe("");
      storedMessages = JSON.parse(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const t = await appTest();
    const { userId, sessionId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "transport-audit" });
      return { userId, sessionId: await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 }) };
    });
    const user = t.withIdentity({ subject: `${userId}|${sessionId}` });
    await user.mutation(api.sync.createVault, { wrappedKey: new ArrayBuffer(1), iv: new ArrayBuffer(1) });

    const file = await t.run((ctx) => ctx.storage.store(new Blob(["encrypted-chat-upload"])));
    const put = { key: "chat:audit", base: 0, deleted: false, iv: new ArrayBuffer(12), file };
    expect(await user.mutation(api.sync.put, put)).toEqual({ seq: 1 });
    expect(await user.mutation(api.sync.put, put)).toEqual({ seq: 1, conflict: true });
    expect(await t.run(async (ctx) => (await ctx.db.query("records").first())!.file)).toBe(file);
    currentFileExists = await t.run(async (ctx) => (await ctx.storage.get(file)) !== null);

    const draftFile = await t.run((ctx) => ctx.storage.store(new Blob(["encrypted-draft-upload"])));
    const draft = { key: "draft:audit", deleted: false, iv: new ArrayBuffer(12), file: draftFile };
    await user.mutation(api.sync.putDraft, { ...draft, at: 200 });
    await user.mutation(api.sync.putDraft, { ...draft, at: 100 });
    expect(await t.run(async (ctx) => (await ctx.db.query("drafts").first())!.file)).toBe(draftFile);
    currentDraftFileExists = await t.run(async (ctx) => (await ctx.storage.get(draftFile)) !== null);
  });

  test.failing("a stale local chat save must not erase a newer completed reply", () => {
    expect(storedMessages).toEqual(["prompt", "finished reply"]);
  });

  test.failing("a conflicting file-backed record retry must not delete acknowledged ciphertext", () => {
    expect(currentFileExists).toBe(true);
  });

  test.failing("a rejected older draft must not delete the current draft's ciphertext", () => {
    expect(currentDraftFileExists).toBe(true);
  });
});
