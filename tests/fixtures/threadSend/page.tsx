// The whole app on the reload page's fake server (a long finished thread, t0), for
// tests/threadSendScroll.test.ts to send in while scrolled up. A send, the reply streaming, a steer
// landing in it and a queued message going out each change the store just as lib/chat.ts does, as
// the fake server runs no replies; queuing goes through the real composer.
import "../reloadScroll/fakeServer";
import "@fontsource-variable/geist";
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import type { Chat, Message } from "../../../src/lib/types";

const { App, preloadApp } = await import("../../../src/App");
const { useStore } = await import("../../../src/lib/store");
const { shiftQueue, queueOf } = await import("../../../src/lib/queue");
await preloadApp();

let n = 0;
const chat = () => useStore.getState().chats.find((c) => c.id === "t0")!;
const reply = () => chat().messages.at(-1)!;
const patch = (p: Partial<Message> | ((m: Message) => Partial<Message>)) => useStore.getState().patchMessage("t0", reply().id, p);

Object.assign(window, {
  store: useStore,
  queued: () => queueOf("t0").length,
  /** What sendMessage does: the user's message and a reply on its way, in one change. */
  send(text: string) {
    const now = Date.now();
    const user: Message = { id: `sent-${++n}`, role: "user", content: text, createdAt: now };
    const assistant: Message = { id: `reply-${n}`, role: "assistant", content: "", status: "streaming", model: { plan: "pi", id: "fixture/model", name: "Fixture" }, createdAt: now, startedAt: now };
    useStore.getState().upsertChat({ ...chat(), updatedAt: now, messages: [...chat().messages, user, assistant] });
  },
  /** The reply writing, as the stream's text events do. */
  write(text: string) {
    patch((m) => ({ content: m.content + text, parts: [...(m.parts ?? []).filter((p) => p.type !== "text"), { type: "text", text: m.content + text }] }));
  },
  /** A steered message landing in the reply, where Pi read it. */
  steer(text: string) {
    patch((m) => ({ parts: [...(m.parts ?? []), { type: "steer", id: `steer-${++n}`, text }] }));
  },
  finish() {
    patch({ status: "done" });
  },
  /** The server's copy of the thread replacing this tab's, the same messages over again. */
  confirm() {
    useStore.getState().setChats(useStore.getState().chats.map((c) => (c.id === "t0" ? (JSON.parse(JSON.stringify(c)) as Chat) : c)));
  },
  /** The next queued message going out once the reply is done (drainQueue). */
  drain() {
    const next = shiftQueue("t0");
    if (next) (window as unknown as { send: (t: string) => void }).send(next.text);
  },
});
createRoot(document.getElementById("root")!).render(<App />);
