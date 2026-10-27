// The top right of the window: the Commit button (in a thread whose folder is a git repository),
// and the switches for the side panel (files and terminals, beside the thread) and the file tree.
import { FolderTree, Maximize2, Minimize2, PanelRight } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { usePanel } from "../lib/panel";
import type { Chat } from "../lib/types";
import { cx, useMediaQuery } from "../lib/ui";
import { GitMenu } from "./GitMenu";
import { IconButton } from "./primitives";

export function ThreadTools({ chat, onWidth }: { chat?: Chat; onWidth: (width: number) => void }) {
  const panel = usePanel((s) => s.panel);
  const tree = usePanel((s) => s.tree);
  const expanded = usePanel((s) => s.expanded);
  // No project and no thread: there's no one folder to show files from.
  const hasFiles = usePanel((s) => !!s.folder?.cwd);
  const { setPanel, setTree, setExpanded } = usePanel.getState();
  const narrow = useMediaQuery("(max-width: 768px)");
  const ref = useRef<HTMLDivElement>(null);
  // The panel's tabs keep clear of these buttons, which sit over its top edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => onWidth(el.offsetWidth + 10));
    observer.observe(el);
    return () => observer.disconnect();
  }, [onWidth]);
  const streaming = !!chat && chat.messages.findLast((m) => m.role === "assistant")?.status === "streaming";
  return (
    <div ref={ref} className={cx("thread-tools", (panel || (tree && hasFiles)) && "thread-tools-over")}>
      {panel && !narrow && (
        <IconButton label={expanded ? "Show the thread" : "Expand the panel"} className="thread-tool" onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </IconButton>
      )}
      {/* Right of the panel's expand button, in with the file tree and panel switches. */}
      {chat && <GitMenu chat={chat} streaming={streaming} />}
      {hasFiles && (
        <IconButton
          label={tree ? "Hide files" : "Show files"}
          className={cx("thread-tool", tree && "thread-tool-on")}
          aria-pressed={tree}
          onClick={() => {
            // On a phone there's room for one at a time.
            if (narrow && !tree) setPanel(false);
            setTree(!tree);
          }}
        >
          <FolderTree size={16} />
        </IconButton>
      )}
      <IconButton
        label={panel ? "Hide the side panel" : "Show the side panel"}
        tooltip={panel ? "Hide the side panel" : "Side panel (⌘J for the terminal)"}
        className={cx("thread-tool", panel && "thread-tool-on")}
        aria-pressed={panel}
        onClick={() => {
          if (narrow && !panel) setTree(false);
          setPanel(!panel);
        }}
      >
        <PanelRight size={16} />
      </IconButton>
    </div>
  );
}
