// OpenBots' main pane: the open conversation, and its details panel beside it.
import { Plus } from "lucide-react";
import { useEffect } from "react";
import { useBots } from "../../lib/bots/store";
import { useStore } from "../../lib/store";
import { useMediaQuery } from "../../lib/ui";
import { BotAvatar } from "./BotAvatar";
import { BotChat } from "./BotChat";
import { BotDetails } from "./BotDetails";
import { openBotsDialog } from "./BotsSidebar";

function NoConversation() {
  return (
    <div className="bots-hello">
      <BotAvatar look={{ shape: "puff", color: "white" }} size={120} lively track playful />
      <h2>OpenBots</h2>
      <p>Bots with their own memory and instructions, that keep a conversation going with you and work together in groups.</p>
      <button type="button" className="btn bots-btn bots-btn-primary" onClick={() => openBotsDialog({ kind: "bot" })}>
        <Plus size={15} /> New bot
      </button>
    </div>
  );
}

export function BotsView() {
  const conversation = useBots((s) => s.conversations.find((c) => c.id === s.activeId));
  const detailsOpen = useBots((s) => s.detailsOpen);
  const error = useBots((s) => s.error);
  const pending = useBots((s) => s.pending);
  const connected = useBots((s) => s.connected);
  const loaded = useBots((s) => s.loaded);
  const statuses = useBots((s) => s.status);
  const botStatus = Object.values(statuses).find((s) => s.conversationId === conversation?.id && s.state !== "idle");
  const mobile = useMediaQuery("(max-width: 768px)");
  useEffect(() => useBots.getState().ensureSeeded(), []);
  // On a phone the details cover the chat, so they start closed.
  useEffect(() => {
    if (mobile) useBots.getState().setDetailsOpen(false);
  }, [mobile]);
  // Escape closes the details panel, unless something on top of it (a menu, a dialog) takes it first.
  useEffect(() => {
    if (!detailsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || useStore.getState().settingsOpen) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest("[role='menu'], dialog, textarea, input")) return;
      useBots.getState().setDetailsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailsOpen]);
  return (
    <div className="bots-view">
      {(error || pending > 0 || !connected || botStatus) && <div className="bots-sync-status" role={error || botStatus?.state === "error" ? "alert" : "status"}>
        <span>{error || (pending > 0 ? "Saving changes…" : !connected ? "Reconnecting to OpenBots…" : botStatus?.error || botStatus?.activity || (botStatus?.state === "error" ? "Bot could not complete the request." : "Working…"))}</span>
        {error && <button type="button" className="btn bots-btn" onClick={() => useBots.getState().clearError()}>Dismiss</button>}
      </div>}
      <div className="bots-view-content">
        {conversation ? <BotChat key={conversation.id} conversation={conversation} /> : loaded && <NoConversation />}
        {conversation && <BotDetails conversation={conversation} open={detailsOpen} />}
      </div>
    </div>
  );
}
