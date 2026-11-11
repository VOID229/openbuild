// The real new-thread composer, for tests/remoteControlToggle.test.ts to look at in Chrome.
//   ?runtime=claude | codex   the harness the new thread starts on
//   &thread=on                a Claude Code thread that started with Remote Control on, docked
//   ?settings=general         Settings → General instead, with its Remote control group
// The server is faked: /api/config answers, everything else is empty.
import "./fakeServer";
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { Composer } from "../../../src/components/Composer";
import { SettingsPage } from "../../../src/components/Settings";
import { useStore } from "../../../src/lib/store";
import type { ThreadRuntime } from "../../../shared/types";
import type { ModelInfo } from "../../../shared/types";

const params = new URLSearchParams(location.search);
const runtime = (params.get("runtime") ?? "claude") as ThreadRuntime;
const model: ModelInfo = { id: `${runtime}/one`, name: "Haiku 5.5", protocol: "chat", input: ["text"], reasoning: { efforts: ["low", "high"], mode: "effort", toggle: false } };
const listing = { "": { plan: runtime, status: "valid" as const, models: [model], defaultModel: model.id, checkedAt: Date.now() } };
const thread = params.get("thread") === "on";
const settings = params.get("settings");
useStore.setState({
  settings: { ...useStore.getState().settings, threadRuntime: runtime, workspace: { mode: "local" } },
  claudeModels: listing as any,
  codexModels: listing as any,
  chats: thread ? [{ id: "t", title: "Remote", runtime: "claude", remoteControl: true, createdAt: 0, updatedAt: 0, messages: [] }] : [],
});
Object.assign(window, { store: useStore });
document.documentElement.dataset.theme = "dark";
if (settings) useStore.getState().openSettings(settings as "general");
createRoot(document.getElementById("root")!).render(
  settings ? (
    <main className="main main-page"><SettingsPage /></main>
  ) : thread ? (
    <div className="chat-view" style={{ width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 16 }}>
      <Composer variant="dock" chatId="t" streaming={false} />
    </div>
  ) : (
    <div className="home">
      <div className="home-center">
        <h1 className="home-title">What should we build?</h1>
        <Composer variant="home" streaming={false} />
      </div>
    </div>
  ),
);
