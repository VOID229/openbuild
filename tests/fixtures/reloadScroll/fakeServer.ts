// A fake OpenBuild server for the reload page: a long sidebar of finished threads, the first of them
// a long conversation. Imported before the app, so its config and thread list answer from here.
import type { Chat } from "../../../src/lib/types";

const now = Date.now();
const thread = (n: number, length: number): Chat => ({
  id: `t${n}`, title: `Thread ${n}`, createdAt: now - n * 60_000, updatedAt: now - n * 60_000, done: true,
  messages: Array.from({ length }, (_, i) => i % 2
    ? { id: `t${n}-${i}`, role: "assistant", status: "done", createdAt: now - (length - i) * 1000, content: `## Answer ${i}\n\n${"A reply long enough to wrap over several lines. ".repeat(20)}\n\n\`\`\`ts\nconst answer = ${i};\n\`\`\`\n` }
    : { id: `t${n}-${i}`, role: "user", createdAt: now - (length - i) * 1000, content: `Question ${i}` }),
} as Chat);
const chats = Array.from({ length: 60 }, (_, n) => thread(n, n ? 2 : 60));

window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input instanceof Request ? input.url : input), location.href).pathname;
  if (path === "/api/auth/status") return Response.json({ configured: false, authenticated: true });
  if (path === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: "fixture", machine: "imac" });
  if (path === "/api/devices") return Response.json({ devices: [] });
  if (path === "/api/projects") return Response.json({ projects: [] });
  if (path === "/api/plugins") return Response.json({ plugins: [] });
  if (path === "/api/chats") return Response.json({ chats });
  const one = /^\/api\/chats\/([^/]+)$/.exec(path);
  if (one) {
    const chat = chats.find((c) => c.id === one[1]);
    return chat ? Response.json(chat) : Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({});
}) as typeof fetch;
