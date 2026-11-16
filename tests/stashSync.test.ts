// Stashes kept on the server (server/stashes.ts, src/lib/stash.ts), against a throwaway server
// restarted mid-test. In a browser each address the app is opened at (a LAN IP, a Tailscale name)
// has storage of its own; here each is an IndexedDB database of its own, talking to the server at
// 127.0.0.1 or at localhost.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createStore, set } from "../src/lib/kv";
import { heldFile, holdFile, releaseFile } from "../src/lib/localFiles";
import { createStash, type Stashed } from "../src/lib/stash";
import type { Attachment } from "../shared/types";
import { ThrowawayServer } from "./stashServer";

const server = new ThrowawayServer();
const realFetch = globalThis.fetch;
beforeAll(async () => {
  await server.start();
  // The app's own requests are relative to the page: here, to the server.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? server.url + input : input, init)) as typeof fetch;
}, 60_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await server.dispose();
});

/** The app as one address's tab sees it: its own storage, the server at `host`, offline while `down()`. */
function openAt(storage: string, host: "127.0.0.1" | "localhost", down = () => false) {
  return createStash(storage, "threads", {
    serverBacked: async () => true,
    fetch: (path, init) => (down() ? Promise.reject(new TypeError("Failed to fetch")) : realFetch(`http://${host}:${server.port}${path}`, init)),
  });
}

const serverIds = async () => (await server.json<{ ids: string[] }>("/api/stashes/threads")).ids;
const image: Attachment = { id: "img", name: "shot.png", mime: "image/png", size: 4, dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
const legacy = (id: string, text: string, createdAt: number, files: Attachment[] = []): Stashed => ({ id, text, files, createdAt });
const uuid = () => crypto.randomUUID();

test("stashes an older build kept per address come over once, without duplicates, and every address sees them after a restart", async () => {
  // What a browser kept at the LAN address, and (one of them stashed there too) at the Tailscale name.
  const [lan1, lan2, tail1, tail2] = [uuid(), uuid(), uuid(), uuid()];
  const lanStore = createStore("legacy-lan", "stash");
  await set(lan1, legacy(lan1, "from the LAN, with a picture", 1, [image]), lanStore);
  await set(lan2, legacy(lan2, "second on the LAN", 2), lanStore);
  const tailStore = createStore("legacy-tailscale", "stash");
  await set(tail1, legacy(tail1, "from the LAN, with a picture", 3, [{ ...image, id: "img-2" }]), tailStore);
  await set(tail2, legacy(tail2, "only on Tailscale", 4), tailStore);

  const lan = openAt("legacy-lan", "127.0.0.1");
  await lan.sync();
  expect(new Set(await serverIds())).toEqual(new Set([lan1, lan2]));
  // Opened again (a reload): nothing is sent twice.
  const reloaded = openAt("legacy-lan", "127.0.0.1");
  await reloaded.sync();
  expect((await serverIds()).length).toBe(2);
  expect(reloaded.use.getState().items.map((s) => s.text)).toEqual(["second on the LAN", "from the LAN, with a picture"]);

  await server.restart();

  // The Tailscale name, opened for the first time since: its own one comes over, the one just like
  // the LAN's doesn't, and it sees the LAN's, picture and all.
  const tail = openAt("legacy-tailscale", "localhost");
  await tail.sync();
  expect(new Set(await serverIds())).toEqual(new Set([lan1, lan2, tail2]));
  const items = tail.use.getState().items;
  expect(items.map((s) => s.text)).toEqual(["only on Tailscale", "second on the LAN", "from the LAN, with a picture"]);
  expect(items.find((s) => s.id === lan1)?.files).toEqual([image]);
  // And the LAN address sees the Tailscale one.
  await lan.sync();
  expect(lan.use.getState().items.map((s) => s.id)).toEqual([tail2, lan2, lan1]);
}, 60_000);

test("a stash made while the server is down shows, outlasts a reload, and is sent once it's back; one used elsewhere isn't brought back", async () => {
  let down = false;
  const phone = openAt("offline-phone", "127.0.0.1", () => down);
  await server.stop();
  down = true;
  const made = phone.add("written on the train", [image]);
  await phone.sync();
  expect(phone.use.getState().items.map((s) => s.id)).toContain(made.id);
  // Reloaded, still offline: it's still there, still waiting.
  const again = openAt("offline-phone", "127.0.0.1", () => down);
  await again.sync();
  expect(again.use.getState().items.map((s) => s.id)).toContain(made.id);

  await server.start();
  down = false;
  await again.sync();
  expect(await serverIds()).toContain(made.id);

  // Used at the other address.
  const desk = openAt("offline-desk", "localhost");
  await desk.sync();
  expect(desk.use.getState().items.map((s) => s.id)).toContain(made.id);
  desk.remove(made.id);
  await desk.sync();
  expect(await serverIds()).not.toContain(made.id);
  // The phone's copy goes when it next syncs, and an old build's copy of it (another address, not
  // opened since) can't bring it back.
  await again.sync();
  expect(again.use.getState().items.map((s) => s.id)).not.toContain(made.id);
  const stale = createStore("offline-stale", "stash");
  await set(made.id, legacy(made.id, made.text, made.createdAt, made.files), stale);
  const old = openAt("offline-stale", "localhost");
  await old.sync();
  expect(old.use.getState().items.map((s) => s.id)).not.toContain(made.id);
  expect(await serverIds()).not.toContain(made.id);
}, 60_000);

test("a file the browser held for a stash goes to the server with it, and outlasts the browser letting go of it", async () => {
  const fileId = uuid();
  holdFile(fileId, new File(["zip bytes here"], "notes.zip", { type: "application/zip" }));
  const held: Attachment = { id: fileId, name: "notes.zip", mime: "application/zip", size: 14, dataUrl: "", local: true };
  const lan = openAt("files-lan", "127.0.0.1");
  const item = lan.add("with an archive", [held]);
  await lan.sync();
  expect(await serverIds()).toContain(item.id);
  const res = await fetch(`/api/stash-files/${fileId}`);
  expect(await res.text()).toBe("zip bytes here");

  await server.restart();

  // This browser no longer holds it (another address, or long after): it comes from the server.
  releaseFile(fileId);
  const file = await heldFile(fileId, { name: "notes.zip" });
  expect(await file?.text()).toBe("zip bytes here");
  expect(file?.name).toBe("notes.zip");
  // Used: the stash goes, the file stays for the composer it went to.
  const tail = openAt("files-tailscale", "localhost");
  await tail.sync();
  tail.remove(item.id);
  await tail.sync();
  expect(await serverIds()).not.toContain(item.id);
  expect((await fetch(`/api/stash-files/${fileId}`, { method: "HEAD" })).status).toBe(200);
}, 60_000);

test("OpenBots' stash is kept apart from OpenBuild's", async () => {
  const bots = createStash("bots-only", "bots", { serverBacked: async () => true, fetch: (path, init) => realFetch(server.url + path, init) });
  const item = bots.add("for the bots", []);
  await bots.sync();
  expect((await server.json<{ ids: string[] }>("/api/stashes/bots")).ids).toContain(item.id);
  expect(await serverIds()).not.toContain(item.id);
}, 30_000);
