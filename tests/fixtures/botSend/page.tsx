// A real OpenBots chat talking to a fake workspace on the page, for tests/botComposerSend.test.ts.
// The workspace keeps each message once by id, as the server does. `window.workspace` sets how it
// answers the next sends: at once, held until released, refused, or lost on the way after landing.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotChat } from "../../../src/components/bots/BotChat";
import { enterWorkspace, preloadBots, useBots } from "../../../src/lib/bots/store";
import { useWorkspace } from "../../../src/lib/bots/workspace";
import { getBotDraft } from "../../../src/lib/drafts";
import type { Bot, BotMessage, Conversation } from "../../../src/lib/bots/types";

const kind = new URLSearchParams(location.search).get("kind") === "group" ? "group" : "direct";
const bot = (id: string, name: string, color: string): Bot => ({ id, name, look: { shape: "ghost", color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [bot("manager", "manager", "orange"), bot("helper", "helper", "blue")];
const start = Date.now() - 60_000;
// `?n=`: how many messages the chat starts with, for a test that needs room to scroll up in.
const count = Number(new URLSearchParams(location.search).get("n") ?? 30);
const stored: BotMessage[] = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, author: i % 2 ? "manager" : "me", at: start + i * 1000, text: `${i}. Some earlier message.` }));
const conversation = (): Conversation => ({
  id: "chat",
  kind,
  name: kind === "group" ? "Crew" : undefined,
  botIds: kind === "group" ? ["manager", "helper"] : ["manager"],
  createdAt: start,
  updatedAt: start,
  messages: [...stored],
});

type Mode = "ok" | "refuse" | "lost";
const workspace = {
  mode: "ok" as Mode,
  hold: false,
  /** Whether a file's pieces are turned away. */
  refuseFiles: false,
  /** Every message POST, in order, with the id it carried. */
  posts: [] as { id: string; text: string; images?: string[]; files?: BotMessage["files"] }[],
  /** Every piece of a file PUT, in order: which file, where in it, and how many bytes. */
  pieces: [] as { id: string; name: string; offset: number; bytes: number }[],
  held: [] as (() => void)[],
  release() {
    for (const go of this.held.splice(0)) go();
  },
  stored: () => stored.map((m) => m.id),
  /** The chat's saved draft, as a reload would find it. */
  draft: () => getBotDraft("srv", "chat", true)?.text ?? "",
};
Object.assign(window, { workspace, bots: useBots });

const headers = { "x-openbuild-server": "srv" };
const real = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = new URL(String(input), location.href).pathname;
  const method = init.method ?? "GET";
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const m = /^\/api\/workspace\/to\/srv(\/.*)$/.exec(path);
  if (!m) return path.startsWith("/api/") ? Response.json({}) : real(input, init);
  const rest = m[1]!;
  if (rest === "/api/bots") return Response.json({ bots, conversations: [conversation()], settings: { sections: [] }, typing: {}, drafts: [], status: {} }, { headers });
  if (rest === "/api/bots/stream") return new Response(new ReadableStream(), { headers });
  const file = /^\/api\/bots\/conversations\/chat\/files\/([^/]+)$/.exec(rest);
  if (method === "PUT" && file) {
    if (workspace.refuseFiles) return Response.json({ error: "No room for files." }, { status: 413, headers });
    const q = new URL(String(input), location.href).searchParams;
    const bytes = (init.body as Blob).size;
    workspace.pieces.push({ id: file[1]!, name: q.get("name")!, offset: Number(q.get("offset")), bytes });
    if (workspace.hold) await new Promise<void>((go) => workspace.held.push(go));
    return Response.json({ id: file[1], name: q.get("name"), mime: q.get("type") || "application/octet-stream", size: Number(q.get("offset")) + bytes, path: `/data/attachments/${file[1]}/${q.get("name")}` }, { headers });
  }
  if (method === "POST" && rest.endsWith("/messages")) {
    const body = JSON.parse(String(init.body)) as BotMessage;
    workspace.posts.push({ id: body.id, text: body.text, images: body.images, files: body.files });
    const mode = workspace.mode;
    if (workspace.hold) await new Promise<void>((go) => workspace.held.push(go));
    if (mode === "refuse") return Response.json({ error: "Not allowed right now." }, { status: 400, headers });
    if (!stored.some((x) => x.id === body.id)) stored.push(body);
    // Landed, but the answer never made it back (a proxy's 502 has no server header).
    if (mode === "lost") return new Response("Bad gateway", { status: 502 });
    return Response.json(body, { headers });
  }
  return Response.json({ ok: true }, { headers });
}) as typeof fetch;

function Chat() {
  const c = useBots((s) => s.conversations.find((x) => x.id === "chat"));
  return c ? <BotChat conversation={c} /> : null;
}

useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
await preloadBots();
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ height: "100%" }}>
    <div className="bots-view-content">
      <Chat />
    </div>
  </div>,
);
