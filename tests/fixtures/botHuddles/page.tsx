// Groups' avatars wherever they show, for tests/botHuddleLayout.test.ts to measure in Chrome: the real
// OpenBots sidebar (rows and pinned tiles) and the other places a group's huddle goes, the rail, the
// hover card, the chat's header and Settings, at each of their sizes. All of them doze, as the sidebar's
// do with no one at work, so a "zzz" shows wherever a huddle has one; the plain sizes have it on, even
// below a seat's size where the app sets none, to see it beside the count. `?theme=light` for the light theme.
import "../../../src/styles.css";
import "../../../src/bots.css";
import "../../../src/mobile.css";
import { createRoot } from "react-dom/client";
import { BotsSidebar } from "../../../src/components/bots/BotsSidebar";
import { ConversationAvatar } from "../../../src/components/bots/common";
import { useBots } from "../../../src/lib/bots/store";
import { useStore } from "../../../src/lib/store";
import type { Bot, Conversation } from "../../../src/lib/bots/types";

const bot = (id: string, shape: string, color: string): Bot => ({ id, name: id, look: { shape, color }, instructions: "", memory: [], routines: [], createdAt: 1 });
const bots = [
  bot("pip", "puff", "white"), bot("manager", "tile", "blue"), bot("tracer", "spark", "teal"), bot("scout", "bean", "green"),
  bot("boo", "jelly", "amber"), bot("pill", "pill", "purple"), bot("moss", "orb", "pink"),
];
const ids = bots.map((b) => b.id);
const at = Date.now() - 60_000;
const group = (n: number, pinnedAt?: number): Conversation => ({
  id: `g${n}${pinnedAt ? "-pinned" : ""}`, kind: "group", name: `Crew of ${n}`, botIds: ids.slice(0, n), createdAt: at, updatedAt: at, pinnedAt, messages: [{ id: `g${n}-m`, author: "me", at, text: "hello" }],
});
const pinned = [group(4, 1), group(5, 2), group(7, 3)];
const rows = [group(3), group(5), group(7)];
useStore.setState({ botsOpen: true, botsSidebarOpen: true });
useBots.setState({ bots, conversations: [...pinned, ...rows], activeId: "g5", loaded: true, connected: true, ensureSeeded: () => {} });
if (new URLSearchParams(location.search).get("theme") === "light") document.documentElement.dataset.theme = "light";
else document.documentElement.dataset.theme = "dark";

const sizes = [4, 5, 7].map((n) => rows.find((c) => c.botIds.length === n) ?? group(n));
function Places() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: 20, background: "var(--bg)", color: "var(--text)", fontSize: 13 }}>
      <div data-place="rail" style={{ display: "flex", gap: 6, background: "var(--surface)", padding: 6, borderRadius: 16 }}>
        {sizes.map((c) => (
          <button key={c.id} type="button" className="bots-rail-item" data-group={c.botIds.length}><ConversationAvatar conversation={c} size={40} alive={false} working={[]} /></button>
        ))}
      </div>
      <div data-place="peek" style={{ display: "flex", gap: 10 }}>
        {sizes.map((c) => (
          <div key={c.id} className="bots-peek" data-state="open" data-group={c.botIds.length} style={{ position: "static", pointerEvents: "auto" }}>
            <span className="bots-peek-head"><ConversationAvatar conversation={c} size={18} alive={false} working={[]} badge={false} /><span className="bots-peek-name">{c.name}</span></span>
            <span className="bots-peek-preview">hello</span>
          </div>
        ))}
      </div>
      {[26, 34, 96].map((size) => (
        <div key={size} data-place={`size-${size}`} style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {sizes.map((c) => (
            <span key={c.id} data-group={c.botIds.length} style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 12 }}><ConversationAvatar conversation={c} size={size} alive={false} working={[]} />{size < 40 && <b>{c.name}</b>}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { bots: useBots });
createRoot(document.getElementById("root")!).render(<><BotsSidebar /><Places /></>);
