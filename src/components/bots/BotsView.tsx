// OpenBots' main pane: the open conversation, and its details panel beside it.
import { Plus } from "lucide-react";
import { useEffect } from "react";
import { useBots, useRemoteWorkspace } from "../../lib/bots/store";
import { useWorkspace } from "../../lib/bots/workspace";
import { useStore } from "../../lib/store";
import { useMediaQuery } from "../../lib/ui";
import { BotAvatar } from "./BotAvatar";
import { BotChat } from "./BotChat";
import { BotDetails } from "./BotDetails";
import { openBotsDialog } from "./BotsSidebar";
import { useSlow } from "./common";
import { KeptElsewhere, NotConfirmed, WorkspaceProblem, WorkspaceSwitchDialog, workspaceTrouble } from "./WorkspaceStatus";

function NoConversation() {
  const host = useRemoteWorkspace();
  if (host)
    return (
      <div className="bots-hello">
        <BotAvatar look={{ shape: "puff", color: "white" }} size={120} lively track playful />
        <h2>{host}'s OpenBots</h2>
        <p>Pick a conversation to carry on. New bots and chats are started on {host} itself.</p>
      </div>
    );
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
  const workspace = useBots((s) => s.workspace);
  const remote = !!useRemoteWorkspace();
  const problem = useWorkspace((s) => s.problem);
  const trouble = workspaceTrouble(problem, workspace);
  const isGone = problem?.workspace === workspace && problem?.kind === "gone";
  const detailsOpen = useBots((s) => s.detailsOpen);
  const error = useBots((s) => s.error);
  const connected = useBots((s) => s.connected);
  const loaded = useBots((s) => s.loaded);
  const statuses = useBots((s) => s.status);
  // What a bot is up to shows in the chat itself; up here is only for when it goes wrong.
  const botStatus = Object.values(statuses).find((s) => s.conversationId === conversation?.id && s.state === "error");
  const mobile = useMediaQuery("(max-width: 768px)");
  const slow = useSlow(!connected) && !trouble;
  useEffect(() => useBots.getState().ensureSeeded(), []);
  // On a phone the details cover the chat, so they start closed.
  useEffect(() => {
    if (mobile) useBots.getState().setDetailsOpen(false);
  }, [mobile]);
  // With nothing to show, the way back to the list would be missing with the chat it's in.
  const nothingOpen = mobile && loaded && !conversation;
  useEffect(() => {
    if (nothingOpen) useStore.getState().setBotsSidebarOpen(true);
  }, [nothingOpen]);
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
      {!isGone && trouble && <div className="bots-sync-status bots-workspace-trouble" role="alert"><span>{trouble}</span></div>}
      {!isGone && (error || slow || botStatus) && <div className="bots-sync-status" role={error || botStatus?.state === "error" ? "alert" : "status"}>
        <span>{error || (slow ? "Reconnecting to OpenBots…" : botStatus?.error || "Bot could not complete the request.")}</span>
        {error && <button type="button" className="btn bots-btn" onClick={() => useBots.getState().clearError()}>Dismiss</button>}
      </div>}
      {!isGone && <NotConfirmed />}
      {!isGone && <KeptElsewhere />}
      <div className="bots-view-content">
        {isGone ? <WorkspaceProblem /> : conversation ? <BotChat key={`${workspace}:${conversation.id}`} conversation={conversation} /> : loaded && <NoConversation />}
        {!isGone && conversation && !remote && <BotDetails conversation={conversation} open={detailsOpen} />}
      </div>
      <WorkspaceSwitchDialog />
    </div>
  );
}
