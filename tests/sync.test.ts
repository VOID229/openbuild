// Cloud sync, end to end against the real Convex functions (convex-test runs them in memory) and
// the real sync engine, crypto and app store. "Another device" is simulated by writing records
// straight to the backend with the same account and data key.
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, test } from "bun:test";

// --- A minimal browser environment for the app modules.
const g = globalThis as any;
g.window ??= globalThis;
g.innerWidth = 1280;
g.document ??= { addEventListener() {}, visibilityState: "visible" };
const ls = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };
const realFetch = fetch;
g.fetch = (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("/api/state")) return Promise.resolve(Response.json({ state: null }));
  if (url.startsWith("/api/")) return Promise.resolve(Response.json({ ok: true, chats: [] }));
  return realFetch(input, init);
};

const { convexTest } = await import("convex-test");
const schema = (await import("../convex/schema")).default;
const { api } = await import("../convex/_generated/api");
const { useStore } = await import("../src/lib/store");
const { SyncEngine, useCloud } = await import("../src/lib/cloud/sync");
const crypto_ = await import("../src/lib/cloud/crypto");

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/schema.ts": () => import("../convex/schema"),
  "../convex/sync.ts": () => import("../convex/sync"),
  "../convex/auth.ts": () => import("../convex/auth"),
  "../convex/http.ts": () => import("../convex/http"),
};

type Chat = import("../src/lib/types").Chat;
const msg = (id: string, content: string, createdAt: number) => ({ id, role: "user" as const, content, createdAt, status: "done" as const });
const chat = (id: string, messages: Chat["messages"], extra: Partial<Chat> = {}): Chat => ({ id, title: id, createdAt: 1, updatedAt: 1, messages, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stands in for ConvexReactClient: mutations go to convex-test, and live queries re-run after every write. */
class FakeClient {
  private watchers = new Set<() => Promise<void>>();
  constructor(private t: any) {}
  async mutation(ref: any, args: any) {
    const result = await this.t.mutation(ref, args);
    this.bump();
    return result;
  }
  watchQuery(ref: any, args: any) {
    let result: unknown;
    const listeners = new Set<() => void>();
    const run = async () => {
      result = await this.t.query(ref, args);
      listeners.forEach((fn) => fn());
    };
    this.watchers.add(run);
    void run();
    return {
      onUpdate: (cb: () => void) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
          this.watchers.delete(run);
        };
      },
      localQueryResult: () => result,
    };
  }
  bump() {
    for (const w of this.watchers) void w();
  }
  connectionState() {
    return { isWebSocketConnected: true, hasEverConnected: true };
  }
  subscribeToConnectionState() {
    return () => {};
  }
}

/** Wait until the engine reports it's caught up with nothing left to send. */
async function settled() {
  let calm = 0;
  for (let i = 0; i < 400 && calm < 4; i++) {
    await sleep(25);
    const s = useCloud.getState();
    calm = s.status === "synced" && s.pending === 0 ? calm + 1 : 0;
  }
  if (calm < 4) throw new Error(`Sync didn't settle: ${JSON.stringify(useCloud.getState())}`);
}

let t: any;
let alice: any;
let client: FakeClient;
let dataKey: CryptoKey;
let engine: InstanceType<typeof SyncEngine>;

const records = async () => (await alice.query(api.sync.changes, { since: 0 })) as { key: string; seq: number; deleted: boolean; iv?: ArrayBuffer; data?: ArrayBuffer }[];
const recordOf = async (key: string) => (await records()).find((r) => r.key === key);
const decrypt = async <T>(key: string) => {
  const r = await recordOf(key);
  return crypto_.open<T>(dataKey, key, r!.iv!, r!.data!);
};
/** Write a record as another device would. */
async function remotePut(key: string, value: unknown, base?: number) {
  const sealed = await crypto_.seal(dataKey, key, value);
  const res = await alice.mutation(api.sync.put, { key, base: base ?? (await recordOf(key))?.seq ?? 0, deleted: false, ...sealed });
  client.bump();
  return res;
}

beforeAll(async () => {
  t = convexTest(schema, modules);
  const userId = await t.run((ctx: any) => ctx.db.insert("users", { email: "alice" }));
  alice = t.withIdentity({ subject: `${userId}|session1` });
  client = new FakeClient(alice);
  await useStore.persist.rehydrate();
});

describe("account keys", () => {
  test("the data key unwraps with the right password only", async () => {
    const creds = await crypto_.deriveCredentials("Alice", "correct horse battery");
    const again = await crypto_.deriveCredentials(" alice ", "correct horse battery");
    expect(creds.authSecret).toBe(again.authSecret);
    expect(creds.authSecret).not.toContain("correct horse");
    const created = await crypto_.createDataKey(creds.wrapKey);
    await alice.mutation(api.sync.createVault, { wrappedKey: created.wrappedKey, iv: created.iv });
    dataKey = created.key;

    const me = await alice.query(api.sync.me, {});
    expect(me.username).toBe("alice");
    await crypto_.unwrapDataKey(again.wrapKey, me.vault.wrappedKey, me.vault.iv);
    const wrong = await crypto_.deriveCredentials("alice", "wrong password!!");
    await expect(crypto_.unwrapDataKey(wrong.wrapKey, me.vault.wrappedKey, me.vault.iv)).rejects.toThrow();
    await expect(alice.mutation(api.sync.createVault, { wrappedKey: created.wrappedKey, iv: created.iv })).rejects.toThrow();
  });
});

describe("sync", () => {
  test("first sign-in uploads local chats, settings and profile, encrypted", async () => {
    useStore.setState({ chats: [chat("a", [msg("a1", "my secret prompt", 1)])], chatsLoaded: true });
    useStore.getState().updateProfile({ name: "Alice", bio: "hi" });
    useStore.getState().updateSettings({ theme: "dark", keys: { go: ["local-key-id"] }, selection: { plan: "go", id: "m" } });

    engine = new SyncEngine(client as any, "test|alice", dataKey);
    await engine.start();
    await settled();

    const keys = (await records()).map((r) => r.key).sort();
    expect(keys).toEqual(["chat:a", "profile", "settings"]);
    for (const r of await records()) expect(new TextDecoder().decode(r.data!)).not.toContain("secret");
    expect((await decrypt<Chat>("chat:a")).messages[0]!.content).toBe("my secret prompt");
    expect((await decrypt<any>("profile")).name).toBe("Alice");
    const settings = await decrypt<any>("settings");
    expect(settings.theme).toBe("dark");
    expect(settings.keys).toBeUndefined(); // API key ids stay on the machine
    expect("selection" in settings).toBe(false);
  });

  test("another device's new chat, settings and profile arrive live", async () => {
    await remotePut("chat:b", chat("b", [msg("b1", "from phone", 2)]));
    await remotePut("settings", { ...(await decrypt<any>("settings")), theme: "light" });
    await remotePut("profile", { name: "Alice P", bio: "hi", location: "", language: "" });
    await settled();

    const s = useStore.getState();
    expect(s.chats.find((c) => c.id === "b")?.messages[0]?.content).toBe("from phone");
    expect(s.settings.theme).toBe("light");
    expect(s.settings.keys).toEqual({ go: ["local-key-id"] }); // untouched
    expect(s.settings.selection).toEqual({ plan: "go", id: "m" });
    expect(s.settings.profile.name).toBe("Alice P");
  });

  test("local edits are pushed", async () => {
    const a = useStore.getState().chats.find((c) => c.id === "a")!;
    useStore.getState().upsertChat({ ...a, updatedAt: 10, messages: [...a.messages, msg("a2", "follow-up", 10)] });
    useStore.getState().updateChat("a", { pinned: true });
    await settled();
    const remote = await decrypt<Chat>("chat:a");
    expect(remote.messages.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(remote.pinned).toBe(true);
  });

  test("concurrent edits to one chat are merged, not lost", async () => {
    const before = await recordOf("chat:a");
    const remote = await decrypt<Chat>("chat:a");
    // The other device writes first...
    await alice.mutation(api.sync.put, { key: "chat:a", base: before!.seq, deleted: false, ...(await crypto_.seal(dataKey, "chat:a", { ...remote, messages: [...remote.messages, msg("r", "from phone", 20)] })) });
    // ...while this device, not having seen it yet, adds its own message.
    const a = useStore.getState().chats.find((c) => c.id === "a")!;
    useStore.getState().upsertChat({ ...a, updatedAt: 21, messages: [...a.messages, msg("l", "from laptop", 21)] });
    client.bump();
    await settled();

    const ids = (await decrypt<Chat>("chat:a")).messages.map((m) => m.id);
    expect(ids).toEqual(["a1", "a2", "r", "l"]);
    expect(useStore.getState().chats.find((c) => c.id === "a")!.messages.map((m) => m.id)).toEqual(ids);
  });

  test("deletes sync both ways and stay deleted", async () => {
    const b = await recordOf("chat:b");
    await alice.mutation(api.sync.put, { key: "chat:b", base: b!.seq, deleted: true });
    client.bump();
    await settled();
    expect(useStore.getState().chats.some((c) => c.id === "b")).toBe(false);

    useStore.getState().removeChat("a");
    await settled();
    const a = await recordOf("chat:a");
    expect(a?.deleted).toBe(true);
    expect(a?.data).toBeUndefined();
    // A stale device can't bring it back.
    const res = await remotePut("chat:a", chat("a", []), a!.seq);
    expect(res.deleted).toBe(true);
  });

  test("users can't see each other's data", async () => {
    const bobId = await t.run((ctx: any) => ctx.db.insert("users", { email: "bob" }));
    const bob = t.withIdentity({ subject: `${bobId}|s` });
    expect(await bob.query(api.sync.changes, { since: 0 })).toEqual([]);
    await expect(bob.mutation(api.sync.put, { key: "chat:x", base: 0, deleted: true })).rejects.toThrow(/not set up/);
    await expect(t.query(api.sync.changes, { since: 0 })).rejects.toThrow(/Not signed in/);
  });

  test("deleting the account removes everything", async () => {
    engine.stop();
    while (!(await alice.mutation(api.sync.deleteAccount, {})).done);
    const left = await t.run(async (ctx: any) => ({
      records: (await ctx.db.query("records").collect()).length,
      vaults: (await ctx.db.query("vaults").collect()).length,
      alice: (await ctx.db.query("users").collect()).filter((u: any) => u.email === "alice").length,
    }));
    expect(left).toEqual({ records: 0, vaults: 0, alice: 0 });
  });
});
