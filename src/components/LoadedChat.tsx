// A thread's chat once its history has arrived: in the main pane, and inside OpenBots' details panel.
import { useEffect, useState } from "react";
import { adoptHistory } from "../lib/chat";
import { loadChatHistory } from "../lib/db";
import type { Chat } from "../lib/types";
import { ChatView } from "./ChatView";

export function LoadedChat({ chat }: { chat: Chat }) {
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!chat.historyDeferred) return;
    let live = true;
    setError(undefined);
    void loadChatHistory(chat, true).then(full => {
      if (live) adoptHistory(chat, full);
    }, err => { if (live) setError((err as Error).message); });
    return () => { live = false; };
  }, [chat, attempt]);
  if (!chat.historyDeferred) return <ChatView chat={chat} />;
  return <div className="home"><div className="home-center" role="status">
    <p>{error || "Loading thread…"}</p>
    {error && <button className="btn" onClick={() => retry(n => n + 1)}>Retry</button>}
  </div></div>;
}
