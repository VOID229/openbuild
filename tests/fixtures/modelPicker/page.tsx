// The real composer in a thread, for tests/modelPicker.test.ts to open the model picker in Chrome.
//   ?theme=light | dark    the app's theme (dark by default)
//   &home=1                the new-thread composer instead of a thread's
// The server is faked: /api/config answers, everything else is empty.
import "../remoteControl/fakeServer";
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { Composer } from "../../../src/components/Composer";
import { useStore } from "../../../src/lib/store";
import { usePlugins } from "../../../src/lib/plugins";
import type { Effort, ModelInfo } from "../../../shared/types";

const params = new URLSearchParams(location.search);
const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const model = (id: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: `claude/${id}`, name, protocol: "chat", input: ["text"], reasoning: { efforts, mode: "effort", toggle: false }, contextLimit: 1_000_000, outputCost: 25, ...extra });
const models = [
  model("opus-5-5", "Claude Opus 5.5", { speeds: [{ id: "fast", name: "Fast", description: "Faster output at a higher price" }] }),
  model("sonnet-5-5", "Claude Sonnet 5.5", { outputCost: 15 }),
  model("fable-5-1", "Claude Fable 5.1", { outputCost: 75 }),
  model("haiku-5-5", "Claude Haiku 5.5", { outputCost: 5, contextLimit: 200_000, reasoning: { efforts: ["low", "medium", "high"], mode: "effort", toggle: false } }),
  model("opus-5", "Claude Opus 5"),
  model("opus-4-8", "Claude Opus 4.8"),
  model("opus-4-7", "Claude Opus 4.7"),
  model("legacy", "Claude Legacy (no reasoning levels)", { reasoning: { efforts: [], mode: "none", toggle: false } }),
  // Enough that the provider's list runs past the picker's height and scrolls.
  ...Array.from({ length: 16 }, (_, i) => model(`archive-${i + 1}`, `Claude Archive ${i + 1}`)),
];
const listing = { "": { plan: "claude" as const, status: "valid" as const, models, defaultModel: models[0]!.id, checkedAt: Date.now() } };
const home = params.get("home") === "1";
const pane = Number(params.get("pane")) || 0;
useStore.setState({
  settings: { ...useStore.getState().settings, threadRuntime: "claude", workspace: { mode: "local" }, favorites: [models[0]!.id, models[1]!.id] },
  claudeModels: listing as any,
  permissionModes: Object.fromEntries(["claude||/work/openbuild", "claude||"].map((key) => [key, { modes: [{ id: "default", name: "Ask" }, { id: "bypassPermissions", name: "Full access", description: "Run everything without asking" }], defaultMode: "default", status: "valid" as const, checkedAt: Date.now() }])),
  chats: home ? [] : [{ id: "t", title: "Picker", runtime: "claude", workspace: { cwd: "/work/openbuild", projectName: "openbuild", worktree: true, branch: "openbuild/tmp-picker" }, createdAt: 0, updatedAt: 0, messages: [] } as any],
  activeChatId: home ? undefined : "t",
});
// Provider marks wait for the plugins' icons; there are none here.
await usePlugins.getState().refresh();
Object.assign(window, { store: useStore });
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(
  home ? (
    <div className="home">
      <div className="home-center">
        <h1 className="home-title">What should we build?</h1>
        <Composer variant="home" streaming={false} />
      </div>
    </div>
  ) : pane ? (
    // A thread in the OpenBots details panel: a narrow pane on the right that clips what spills out of it.
    <div style={{ width: "100%", display: "flex", justifyContent: "flex-end" }}>
      <div className="side-pane" style={{ width: pane, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 16 }}>
        <Composer variant="dock" chatId="t" streaming={false} />
      </div>
    </div>
  ) : (
    <div className="chat-view" style={{ width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: 16 }}>
      <Composer variant="dock" chatId="t" streaming={false} />
    </div>
  ),
);
