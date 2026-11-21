// A real OpenBots chat with its model under the box, for tests/composerOptions.test.ts in Chrome.
//   ?kind=direct | group   a chat with one bot (default), or a group of two
//   &theme=light | dark    the app's theme (dark by default)
//   &bot=<json>            fields to set on the bot (its model)
//   &remote=1              another device's workspace, whose bots are set up there
// The test's server answers /api/bots/models with a listing and keeps each PATCH it gets.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotChat } from "../../../src/components/bots/BotChat";
import { enterWorkspace, useBots } from "../../../src/lib/bots/store";
import { trackKeyboardNav } from "../../../src/lib/keyboardNav";
import type { Bot, Conversation } from "../../../src/lib/bots/types";
import { useWorkspace } from "../../../src/lib/bots/workspace";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") === "group" ? "group" : "direct";
const extra = JSON.parse(params.get("bot") ?? "{}") as Partial<Bot>;
const bot = (id: string, name: string, color: string): Bot => ({ id, name, look: { shape: "ghost", color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [{ ...bot("manager", "Juniper", "orange"), ...extra }, bot("helper", "Fern", "blue")];
const start = Date.now() - 60_000;
const conversation: Conversation = {
  id: "chat",
  kind,
  name: kind === "group" ? "Crew" : undefined,
  botIds: kind === "group" ? ["manager", "helper"] : ["manager"],
  createdAt: start,
  updatedAt: start,
  messages: [
    { id: "m1", author: "me", at: start, text: "Can you look at why the login test fails on CI?" },
    { id: "m2", author: "manager", at: start + 4000, text: "On it. It passes here, so I'll check what CI does differently first." },
  ],
};
useWorkspace.setState({ localId: "srv", localName: "Studio iMac" });
enterWorkspace(params.has("remote") ? "other" : "srv");
useBots.setState({ bots, conversations: [conversation], loaded: true, connected: true, defaultModel: "anthropic/claude-sonnet-5-5", ensureSeeded: () => {} });
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
trackKeyboardNav();
function Chat() {
  const shown = useBots((s) => s.conversations[0]!);
  return <BotChat conversation={shown} />;
}
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ height: "100%" }}>
    <div className="bots-view-content">
      <Chat />
    </div>
  </div>,
);
