// A real OpenBots chat on the workspace tests/botQuestionSteps.test.ts serves: what the page shows
// is what that workspace holds, so a reload shows what was saved and nothing else.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotChat } from "../../../src/components/bots/BotChat";
import { enterWorkspace, preloadBots, useBots } from "../../../src/lib/bots/store";
import { useWorkspace } from "../../../src/lib/bots/workspace";

function Chat() {
  const c = useBots((s) => s.conversations.find((x) => x.id === "chat"));
  return c ? <BotChat conversation={c} /> : null;
}

useWorkspace.setState({ localId: "srv", localName: "Studio" });
enterWorkspace("srv");
await preloadBots();
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
createRoot(document.getElementById("root")!).render(
  <div className="bots-view" style={{ height: "100%", width: "100%" }}>
    <div className="bots-view-content">
      <Chat />
    </div>
  </div>,
);
