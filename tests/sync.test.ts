// Cloud sync, end to end against the real Convex functions (convex-test runs them in memory) and
// the real sync engine, crypto and app store. "Another device" is simulated by writing records
// straight to the backend with the same account and data key.
import "fake-indexeddb/auto";
import { beforeAll, describe, expect, test } from "bun:test";

// --- A minimal browser environment for the app modules.
const g = globalThis as any;
g.window ??= globalThis;
g.innerWidth = 1280;
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };
const ls = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };
const realFetch = fetch;
/** Stands in for the local server's key vault (OS keychain): scope -> secrets, in order. */
const vault = new Map<string, string[]>();
const keyIds = () => Object.fromEntries([...vault].filter(([, l]) => l.length).map(([s, l]) => [s, l.map((k) => `id-${k}`)]));
g.fetch = async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "/api/keys/secrets") return Response.json({ secrets: Object.fromEntries([...vault].filter(([, l]) => l.length)) });
  if (url === "/api/keys") return Response.json({ backend: "file", keys: keyIds() });
  if (url.startsWith("/api/keys/") && init?.method === "PUT") {
    const scope = url.slice("/api/keys/".length);
    const edits = JSON.parse(init.body).keys as ({ id: string } | { secret: string })[];
    const list = [...new Set(edits.map((e) => ("id" in e ? e.id.slice(3) : e.secret)))];
    vault.set(scope, list);
    return Response.json({ ids: list.map((k) => `id-${k}`) });
  }
  if (url.startsWith("/api/state")) return Response.json({ state: null });
  if (url.startsWith("/api/models")) return Response.json({ plan: "go", status: "invalid", models: [], checkedAt: 0 });
  if (url.startsWith("/api/")) return Response.json({ ok: true, chats: [] });
  return realFetch(input, init);
};

const { appTest } = await import("./convex");
const { api, internal } = await import("../convex/_generated/api");
const drafts = await import("../src/lib/drafts");
const { useStore } = await import("../src/lib/store");
const { SyncEngine, useCloud } = await import("../src/lib/cloud/sync");
const crypto_ = await import("../src/lib/cloud/crypto");

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
  query(ref: any, args: any) {
    return this.t.query(ref, args);
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

const draftRow = (key: string) => t.run(async (ctx: any) => (await ctx.db.query("drafts").collect()).find((d: any) => d.key === key) ?? null);
const draftOf = async (key: string) => {
  const d = await draftRow(key);
  return crypto_.open<any>(dataKey, key, d.iv, d.data);
};
/** Alice signed in on a second device (another session of the same account). */
async function otherDevice() {
  const userId = (await t.run(async (ctx: any) => ctx.db.query("vaults").first())).userId;
  const sessionId = await t.run(async (ctx: any) => ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 }));
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}
async function phonePut(phone: any, key: string, value: unknown, at: number) {
  await phone.mutation(api.sync.putDraft, { key, at, deleted: false, ...(await crypto_.seal(dataKey, key, value)) });
}

/** A user with a session, as Convex Auth would leave them after signing in. */
async function signedIn(username: string) {
  const { userId, sessionId } = await t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", { email: username });
    return { userId, sessionId: await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 }) };
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

beforeAll(async () => {
  t = await appTest();
  alice = await signedIn("alice");
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
    expect(keys).toEqual(["chat:a", "keys", "profile", "settings"]);
    expect(await decrypt<Record<string, string[]>>("keys")).toEqual({}); // key sync is off by default
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

  test("API keys sync only once turned on, encrypted", async () => {
    vault.set("go", ["sk-laptop-1"]);
    useStore.getState().updateSettings({ syncApiKeys: true });
    await settled();
    expect(await decrypt<Record<string, string[]>>("keys")).toEqual({ go: ["sk-laptop-1"] });
    expect(new TextDecoder().decode((await recordOf("keys"))!.data!)).not.toContain("sk-laptop");
  });

  test("keys from another device arrive, and removals sync", async () => {
    await remotePut("keys", { go: ["sk-laptop-1", "sk-phone"], exa: ["exa-1"] });
    await settled();
    expect(vault.get("go")).toEqual(["sk-laptop-1", "sk-phone"]);
    expect(vault.get("exa")).toEqual(["exa-1"]);

    await remotePut("keys", { go: ["sk-phone"] });
    await settled();
    expect(vault.get("go")).toEqual(["sk-phone"]);
    expect(vault.get("exa") ?? []).toEqual([]);

    // A key added here goes up.
    await useStore.getState().setKeys("go", [{ id: "id-sk-phone" }, { secret: "sk-laptop-2" }]);
    await settled();
    expect(await decrypt<Record<string, string[]>>("keys")).toEqual({ go: ["sk-phone", "sk-laptop-2"] });
  });

  test("turning key sync off clears the account's copy; turning it on again merges, losing nothing", async () => {
    useStore.getState().updateSettings({ syncApiKeys: false });
    await settled();
    expect(await decrypt<Record<string, string[]>>("keys")).toEqual({});
    expect(vault.get("go")).toEqual(["sk-phone", "sk-laptop-2"]); // kept locally

    // While off here, this device gets a new key, and another device turns sync on with its own keys.
    vault.set("brave", ["brave-local"]);
    await remotePut("settings", { ...(await decrypt<any>("settings")), syncApiKeys: true });
    await remotePut("keys", { go: ["sk-tablet"] });
    await settled();
    expect(useStore.getState().settings.syncApiKeys).toBe(true);
    expect(vault.get("go")).toEqual(["sk-tablet", "sk-phone", "sk-laptop-2"]);
    expect(await decrypt<Record<string, string[]>>("keys")).toEqual({ brave: ["brave-local"], go: ["sk-tablet", "sk-phone", "sk-laptop-2"] });
  });

  test("a draft is saved with one call, kept out of the live feed every device watches", async () => {
    const image = { id: "img1", name: "a.png", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,AAA" } as any;
    const lastSeq = Math.max(...(await records()).map((r) => r.seq));
    drafts.saveDraft("a", "half-written", [image]);
    await (engine as any).pushDrafts();
    expect(await draftOf("draft:a")).toMatchObject({ text: "half-written", fileIds: ["img1"] });
    expect(await draftOf("draftfile:img1")).toEqual(image);
    expect(Math.max(...(await records()).map((r) => r.seq))).toBe(lastSeq);
    expect((await records()).some((r) => r.key.startsWith("draft"))).toBe(false);

    // Editing the text writes the draft only, not the image again.
    const fileWrite = (await draftRow("draftfile:img1")).changedAt;
    drafts.saveDraft("a", "half-written, now more", [image]);
    await (engine as any).pushDrafts();
    expect((await draftOf("draft:a")).text).toBe("half-written, now more");
    expect((await draftRow("draftfile:img1")).changedAt).toBe(fileWrite);

    // A device isn't handed back its own drafts.
    expect(await alice.query(api.sync.liveDrafts, {})).toEqual([]);
  });

  test("another device's drafts arrive live, pictures included; the newer edit wins", async () => {
    const phone = await otherDevice();
    /** The live subscription updates (the fake client re-runs it), then the engine applies it. */
    const pull = async () => {
      client.bump();
      await sleep(50);
      await (engine as any).draftChain;
    };
    const photo = { id: "img3", name: "p.jpg", mime: "image/jpeg", size: 3, dataUrl: "data:image/jpeg;base64,CCC" } as any;
    await phonePut(phone, "draftfile:img3", photo, Date.now());
    await phonePut(phone, "draft:a", { text: "from phone", fileIds: ["img1", "img3"], updatedAt: Date.now() + 1000 }, Date.now() + 1000);
    await pull();
    expect(drafts.getDraft("a")?.text).toBe("from phone");
    expect(drafts.getDraft("a")?.files).toEqual([expect.objectContaining({ id: "img1" }), photo]);

    // An older one doesn't replace it (the server keeps the newer one too).
    await phonePut(phone, "draft:a", { text: "stale", fileIds: [], updatedAt: 5 }, 5);
    await pull();
    expect(drafts.getDraft("a")?.text).toBe("from phone");
    expect((await draftOf("draft:a")).text).toBe("from phone");

    // Sent on the phone: cleared here on the next fetch.
    await phone.mutation(api.sync.putDraft, { key: "draft:a", at: Date.now() + 1500, deleted: true });
    await pull();
    expect(drafts.getDraft("a")).toBeUndefined();

    // A cleared draft can be written again.
    await sleep(1600);
    drafts.saveDraft("a", "a new draft", []);
    await (engine as any).pushDrafts();
    expect((await draftOf("draft:a")).text).toBe("a new draft");
  });

  test("the server deletes expired drafts; writing a draft keeps its images alive", async () => {
    const image = { id: "img2", name: "b.png", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,BBB" } as any;
    drafts.saveDraft("b", "with picture", [image]);
    await (engine as any).pushDrafts();
    const setExpiry = async (key: string, at: number) => {
      const { _id } = await draftRow(key);
      await t.run((ctx: any) => ctx.db.patch(_id, { expiresAt: at }));
    };
    await setExpiry("draftfile:img2", Date.now() + 1000);
    drafts.saveDraft("b", "with picture, edited", [image]);
    await (engine as any).pushDrafts();
    expect((await draftRow("draftfile:img2")).expiresAt).toBeGreaterThan(Date.now() + 60_000);

    await setExpiry("draft:b", 1);
    await setExpiry("draftfile:img2", 1);
    await t.mutation(internal.sync.expireDrafts, {});
    expect(await draftRow("draft:b")).toBeNull();
    expect(await draftRow("draftfile:img2")).toBeNull();
    expect(await draftRow("draft:a")).not.toBeNull();
    expect((await records()).map((r) => r.key)).toContain("chat:a");
  });

  test("writes don't touch the vault every device watches, and carry on an existing account's count", async () => {
    const vault = () => t.run(async (ctx: any) => ctx.db.query("vaults").first());
    const before = await vault();
    const last = Math.max(...(await records()).map((r) => r.seq));
    const res = await remotePut("chat:seq", chat("seq", []));
    expect(res.seq).toBeGreaterThan(last);
    expect(await vault()).toEqual(before);

    // An account whose counter still lives in the vault (before `seqs`) continues from it.
    await t.run(async (ctx: any) => {
      for (const c of await ctx.db.query("seqs").collect()) await ctx.db.delete(c._id);
      await ctx.db.patch(before._id, { seq: res.seq + 10 });
    });
    expect((await remotePut("chat:seq", chat("seq", []))).seq).toBe(res.seq + 11);
    await settled();
  });

  test("users can't see each other's data", async () => {
    const bob = await signedIn("bob");
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
      seqs: (await ctx.db.query("seqs").collect()).length,
      drafts: (await ctx.db.query("drafts").collect()).length,
      alice: (await ctx.db.query("users").collect()).filter((u: any) => u.email === "alice").length,
    }));
    expect(left).toEqual({ records: 0, vaults: 0, seqs: 0, drafts: 0, alice: 0 });
  });
});
