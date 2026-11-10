// The Advanced tab of a bot's details panel, at the panel's own width, for tests/botAdvancedChrome.test.ts
// to measure in Chrome. The server is faked here: the models bots run on and the bot, with its own
// fallback list; what the tab saves is kept in `window.saved`.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotAdvanced } from "../../../src/components/bots/BotAdvanced";
import { enterWorkspace, useBots } from "../../../src/lib/bots/store";
import type { Bot } from "../../../src/lib/bots/types";
import { useWorkspace } from "../../../src/lib/bots/workspace";

const params = new URLSearchParams(location.search);
const reasoning = { efforts: ["low", "medium", "high", "xhigh"], mode: "effort", toggle: false };
const model = (id: string, name: string, provider: string) => ({ id, name, provider, protocol: "openai", reasoning, input: ["text"] });
const models = [
  model("anthropic/claude-opus-5-5", "Claude Opus 5.5", "anthropic"),
  model("openai-codex/gpt-6.1-sol", "GPT 6.1 Sol", "openai-codex"),
  model("openai-codex-2/gpt-6.1-sol", "GPT 6.1 Sol", "openai-codex-2"),
  model("opencode-go/glm-5.3-long-context-preview", "GLM 5.3 Long Context Preview", "opencode-go"),
];
(window as any).saved = [];
window.fetch = (async (input: string, init?: RequestInit) => {
  const path = String(input).replace(location.origin, "");
  if (path.startsWith("/api/bots/models")) return Response.json({ models, defaultModel: models[0]!.id, checkedAt: 1 });
  if (init?.method === "PATCH") (window as any).saved.push({ path, ...JSON.parse(String(init.body)) });
  return Response.json({});
}) as typeof fetch;

useWorkspace.setState({ localId: "srv", localName: "Studio iMac" });
enterWorkspace("srv");
const fallbackModels = params.get("fallbacks") === "none" ? [] : models.slice(1).map((m) => m.id);
useBots.setState({ bots: [{ id: "b1", name: "Scout", look: {}, instructions: "", createdAt: 1, routines: [], fallbackModels } as unknown as Bot] });
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";

function Page() {
  const bot = useBots((s) => s.bots[0]!);
  return (
    <aside className="bots-details bots-details-open">
      <div className="bots-details-inner">
        <div className="bots-details-scroll">
          <BotAdvanced bot={bot} />
        </div>
      </div>
    </aside>
  );
}
createRoot(document.getElementById("root")!).render(<Page />);
