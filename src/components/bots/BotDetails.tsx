// OpenBots' details panel, beside the chat: a bot's look, name, instructions and routines, with its
// model, computer and OpenBuild permissions under an Advanced tab; a group's members, goal and working threads;
// who's in a side chat.
import { ChevronLeft, Maximize2, Minus, Pencil, Plus, Trash, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { threadActivity, threadMascot } from "../../lib/bots/activity";
import type { BotLook } from "../../lib/bots/looks";
import { clampThreadWidth, loadThreadWidth, saveThreadWidth, THREAD_DEFAULT, THREAD_MIN, threadMax } from "../../lib/bots/threadWidth";
import { conversationName, directOf, useBots } from "../../lib/bots/store";
import type { Bot, Conversation } from "../../lib/bots/types";
import { closeBotsLayer, isPhone } from "../../lib/gestures";
import { useStore } from "../../lib/store";
import type { Chat } from "../../lib/types";
import { cx, useMediaQuery, usePresence } from "../../lib/ui";
import { useEdgeDrag } from "../FileTree";
import { LoadedChat } from "../LoadedChat";
import { IconButton, Toggle } from "../primitives";
import { expandBotsThread } from "../Sidebar";
import { BotAdvanced } from "./BotAdvanced";
import { BotAvatar } from "./BotAvatar";
import { LookPicker } from "./BotDialogs";
import { openBotsDialog } from "./BotsSidebar";
import { ConversationAvatar, useBusyBots } from "./common";

function InlineName({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing)
    return (
      <button
        type="button"
        className="bots-details-name"
        data-tooltip="Rename"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  const commit = () => {
    if (draft.trim() && draft.trim() !== value) onChange(draft.trim());
    setEditing(false);
  };
  return (
    <input
      className="input bots-details-name-input"
      value={draft}
      maxLength={48}
      aria-label="Name"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          e.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly (readonly [T, string])[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="bots-tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className="bots-tab" onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Instructions({ value, placeholder, hint, onChange }: { value: string; placeholder: string; hint: string; onChange: (v: string) => void }) {
  return (
    <div className="bots-pane">
      <textarea className="input textarea bots-instructions" value={value} placeholder={placeholder} rows={7} onChange={(e) => onChange(e.target.value)} />
      <p className="bots-hint">{hint}</p>
    </div>
  );
}

export function Routines({ bot }: { bot: Bot }) {
  const st = useBots.getState();
  return (
    <div className="bots-pane">
      {bot.routines.length ? (
        <ul className="bots-cards">
          {bot.routines.map((r) => (
            <li key={r.id} className={cx("bots-card-row bots-routine", !r.enabled && "bots-routine-off")}>
              <span className="bots-card-text">
                <span className="bots-routine-title">{r.title}</span>
                <span className="bots-routine-when">
                  {r.schedule} · {r.enabled ? "Working" : "Paused"}
                </span>
                {r.task && <span className="bots-routine-task">{r.task}</span>}
              </span>
              <IconButton label="Delete routine" tooltipSide="left" className="bots-card-x" onClick={() => st.removeRoutine(bot.id, r.id)}>
                <Trash size={14} />
              </IconButton>
              <Toggle checked={r.enabled} label={r.enabled ? "Pause" : "Resume"} onChange={(on) => st.updateRoutine(bot.id, r.id, { enabled: on })} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="bots-hint">No routines yet. {bot.name.split(" ·")[0]} sets these up itself: tell it what you'd like done and when.</p>
      )}
    </div>
  );
}

export function Members({ conversation, bots }: { conversation: Conversation; bots: Bot[] }) {
  const st = useBots.getState();
  const members = conversation.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  const others = bots.filter((b) => !conversation.botIds.includes(b.id));
  const shared = conversation.friend;
  // A shared chat that stopped syncing is there to read; its members don't change anymore.
  const editable = conversation.kind === "group" && !shared?.ended;
  // A group keeps two bots; a shared chat can be down to none of yours, since the friend's are there too.
  const removable = shared ? members.length > 0 : members.length > 2;
  // As in the group's huddle: awake at work, dozing otherwise.
  const working = useBusyBots(conversation);
  const open = (bot: Bot) => {
    const c = directOf(useBots.getState().conversations, bot.id);
    if (!c) return;
    st.select(c.id);
    // The details cover the chat on a phone, and the chat is what was asked for.
    if (isPhone()) closeBotsLayer("details");
  };
  return (
    <div className="bots-pane">
      {shared && (
        <>
          <div className="bots-pane-label">{shared.friendName}'s bots</div>
          <ul className="bots-cards">
            {shared.members.map((m) => (
              <li key={m.id} className="bots-card-row bots-member">
                <span className="bots-member-main">
                  <BotAvatar look={m.look ?? { shape: "orb", color: "gray" }} size={28} alive={false} />
                  <span className="bots-card-text">{m.name}</span>
                </span>
              </li>
            ))}
            {!shared.members.length && <li className="bots-hint">None yet.</li>}
          </ul>
          <div className="bots-pane-label">Yours</div>
        </>
      )}
      <ul className="bots-cards">
        {shared && !members.length && <li className="bots-hint">None of your bots are in it yet. Add one below: it hears messages that mention it.</li>}
        {members.map((b) => (
          <li key={b.id} className="bots-card-row bots-member">
            <button type="button" className="bots-member-main" onClick={() => open(b)} data-tooltip="Open chat" data-tooltip-side="left">
              <BotAvatar look={b.look} size={28} busy={working.includes(b.id)} asleep={!working.includes(b.id)} />
              <span className="bots-card-text">{b.name}</span>
            </button>
            {editable && removable && (
              <IconButton
                label="Remove from group"
                tooltipSide="left"
                className="bots-card-x"
                onClick={() => {
                  st.updateConversation(conversation.id, { botIds: conversation.botIds.filter((id) => id !== b.id) });
                  st.post(conversation.id, { author: "me", text: "", event: { kind: "left", text: "Removed", detail: b.name, bot: b.id } });
                }}
              >
                <Minus size={14} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {editable && others.length > 0 && (
        <>
          <div className="bots-pane-label">{shared ? "Bring in" : "Add to the group"}</div>
          <ul className="bots-cards">
            {others.map((b) => (
              <li key={b.id} className="bots-card-row bots-member">
                <span className="bots-member-main">
                  <BotAvatar look={b.look} size={28} alive={false} />
                  <span className="bots-card-text">{b.name}</span>
                </span>
                <IconButton
                  label="Add to group"
                  tooltipSide="left"
                  className="bots-card-x bots-card-add"
                  onClick={() => {
                    st.updateConversation(conversation.id, { botIds: [...conversation.botIds, b.id] });
                    st.post(conversation.id, { author: "me", text: "", event: { kind: "joined", text: "Added", detail: b.name, bot: b.id } });
                    st.pulse(b.id, "happy");
                  }}
                >
                  <Plus size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * The coding threads this group's bots started from it that are working now, with the bot that
 * started each. Threads started before chats recorded it are found by the group's "Started a thread"
 * activity, while it's still loaded.
 */
function useGroupThreads(conversation: Conversation): { chat: Chat; bot: string }[] {
  const chats = useStore((s) => s.chats);
  return useMemo(() => {
    const started = new Map<string, string>();
    for (const m of conversation.messages) if (m.event?.kind === "thread" && m.event.text === "Started a thread" && m.event.threadId) started.set(m.event.threadId, m.author);
    return chats.flatMap((chat) => {
      const bot = chat.startedBy ? (chat.startedBy.conversation === conversation.id ? chat.startedBy.bot : undefined) : started.get(chat.id);
      return bot && threadActivity(chat) !== "idle" ? [{ chat, bot }] : [];
    });
  }, [chats, conversation.id, conversation.messages]);
}

/** A row opens its thread inside this panel (ThreadPane), with Back returning to this list. */
function Threads({ threads, bots, open }: { threads: { chat: Chat; bot: string }[]; bots: Bot[]; open: (id: string) => void }) {
  if (!threads.length) return <div className="bots-pane"><p className="bots-hint">No threads working right now. When a bot here starts one, it shows up until it finishes.</p></div>;
  return (
    <div className="bots-pane">
      <ul className="bots-cards">
        {threads.map(({ chat, bot: id }) => {
          const bot = bots.find((b) => b.id === id);
          const activity = threadActivity(chat);
          return (
            <li key={chat.id} className="bots-card-row bots-member">
              <button type="button" className="bots-member-main" onClick={() => open(chat.id)} data-tooltip="Open thread" data-tooltip-side="left">
                {bot && <BotAvatar look={bot.look} size={28} {...threadMascot(activity)} />}
                <span className="bots-card-text">
                  <span className="bots-routine-title">{chat.title}</span>
                  <span className="bots-routine-when">{[bot?.name, chat.workspace?.projectName, activity === "waiting" && "Waiting for you"].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The thread's width (see lib/bots/threadWidth), held to what the panel's row has room for as the window
 * changes. `room` is the row's width, measured from the panel's parent once the panel is mounted.
 */
function useThreadWidth(panel: React.RefObject<HTMLElement | null>, mounted: boolean) {
  const [saved, setSaved] = useState(loadThreadWidth);
  const [room, setRoom] = useState<number>();
  useEffect(() => {
    const row = panel.current?.parentElement;
    if (!row) return;
    const observer = new ResizeObserver(() => setRoom(row.clientWidth));
    observer.observe(row);
    return () => observer.disconnect();
  }, [panel, mounted]);
  const width = room === undefined ? saved : clampThreadWidth(saved, room);
  const set = (w: number) => {
    const next = room === undefined ? Math.max(THREAD_MIN, Math.round(w)) : clampThreadWidth(w, room);
    setSaved(next);
    saveThreadWidth(next);
  };
  return { width, max: room === undefined ? undefined : threadMax(room), set };
}

/** The thread's left edge: drag it (a finger too), use the arrow keys and Home/End, or double-click for the default width. */
function ThreadGrip({ width, max, set }: ReturnType<typeof useThreadWidth>) {
  const drag = useEdgeDrag(width, set, "panel-dragging");
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    const to = e.key === "ArrowLeft" ? width + step
      : e.key === "ArrowRight" ? width - step
      : e.key === "Home" ? THREAD_MIN
      : e.key === "End" ? (max ?? width)
      : undefined;
    if (to === undefined) return;
    e.preventDefault();
    set(to);
  };
  return (
    <div
      className="side-grip bots-thread-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the thread"
      aria-valuenow={width}
      aria-valuemin={THREAD_MIN}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={drag}
      onDoubleClick={() => set(THREAD_DEFAULT)}
      onKeyDown={onKey}
    />
  );
}

/** A coding thread inside the details panel, in place of its tabs, which stay mounted underneath. */
function ThreadPane({ chat, phone, back, size }: { chat: Chat; phone: boolean; back: () => void; size: ReturnType<typeof useThreadWidth> }) {
  return (
    <div className="bots-details-threadpane">
      {!phone && <ThreadGrip {...size} />}
      <div className="bots-details-top bots-details-thread-top">
        <IconButton label="Back to threads" tooltipSide="right" onClick={back}>
          <ChevronLeft size={phone ? 26 : 18} />
        </IconButton>
        <span className="bots-details-thread-title">{chat.title}</span>
        <IconButton label="Open in OpenBuild" tooltipSide="left" onClick={() => {
          useStore.setState({ activeChatId: chat.id, searchFocus: undefined, botsThread: false });
          expandBotsThread();
        }}>
          <Maximize2 size={16} />
        </IconButton>
      </div>
      <div className="bots-details-thread">
        <LoadedChat key={chat.id} chat={chat} />
      </div>
    </div>
  );
}

function LookEditor({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const before = useRef<BotLook>(bot.look);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".bots-details-avatar")) onDone();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onDone();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onDone]);
  return (
    <div ref={ref} className="bots-look-editor" role="dialog" aria-label="Edit look">
      <div className="bots-look-editor-head">
        <span>Look</span>
        <button type="button" className="link-btn" onClick={() => useBots.getState().updateBot(bot.id, { look: before.current })}>
          Reset
        </button>
      </div>
      <LookPicker
        look={bot.look}
        onChange={(look) => {
          useBots.getState().updateBot(bot.id, { look });
          useBots.getState().pulse(bot.id, "happy");
        }}
      />
    </div>
  );
}

export function BotDetails({ conversation, open }: { conversation: Conversation; open: boolean }) {
  const { mounted, visible } = usePresence(open, 260);
  const phone = useMediaQuery("(max-width: 768px)");
  const bots = useBots((s) => s.bots);
  const pulses = useBots((s) => s.pulses);
  const typing = useBots((s) => (s.typing[conversation.id]?.length ?? 0) > 0);
  const working = useBusyBots(conversation);
  const bot = conversation.kind === "direct" ? bots.find((b) => b.id === conversation.botIds[0]) : undefined;
  const [tab, setTab] = useState<"instructions" | "routines" | "advanced" | "members" | "goal" | "threads">(conversation.kind === "direct" ? "instructions" : "members");
  const [editingLook, setEditingLook] = useState(false);
  const threads = useGroupThreads(conversation);
  const st = useBots.getState();
  // Only when the conversation changes: effects run again when OpenBots comes back from a thread
  // opened over it (App's Activity), and that should find the tab it was left on.
  const [tabFor, setTabFor] = useState(conversation.id);
  if (tabFor !== conversation.id) {
    setTabFor(conversation.id);
    setTab(conversation.kind === "direct" ? "instructions" : "members");
  }
  useEffect(() => setEditingLook(false), [conversation.id]);
  // The thread open inside the panel. Kept while the panel is closed and opened again, dropped for another chat.
  const [threadId, setThreadId] = useState<string>();
  const [threadFor, setThreadFor] = useState(conversation.id);
  if (threadFor !== conversation.id) {
    setThreadFor(conversation.id);
    setThreadId(undefined);
  }
  const threadChat = useStore((s) => (threadId ? s.chats.find((c) => c.id === threadId) : undefined));
  const panel = useRef<HTMLElement>(null);
  const size = useThreadWidth(panel, mounted);
  const showing = !!threadChat && tab === "threads";
  const openThread = (id: string) => {
    setThreadId(id);
    if (useStore.getState().chats.find((c) => c.id === id)?.unread) useStore.getState().updateChat(id, { unread: false });
  };
  // Escape steps back to the list first, like Back, before BotsView's takes the panel itself.
  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229 || useStore.getState().settingsOpen) return;
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest("[role='menu'], [role='listbox'], [role='dialog'], dialog")) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !el.classList.contains("composer-input")) return;
      e.preventDefault();
      setThreadId(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showing]);
  if (!mounted) return null;
  const name = conversationName(conversation, bots);
  const close = () => (phone ? closeBotsLayer("details") : st.setDetailsOpen(false));
  return (
    <aside ref={panel} className={cx("bots-details", visible && "bots-details-open", showing && "bots-details-wide")} style={{ "--thread-w": `${size.width}px` } as React.CSSProperties} aria-label="Details">
      {showing && <ThreadPane chat={threadChat} phone={phone} back={() => setThreadId(undefined)} size={size} />}
      <div className="bots-details-inner" hidden={showing}>
        <div className="bots-details-top">
          <IconButton label="Close details" tooltipSide="left" onClick={close}>
            {phone ? <ChevronLeft size={26} /> : <X size={18} />}
          </IconButton>
        </div>
        <div className="bots-details-scroll">
          <div className="bots-details-hero">
            {bot ? (
              <button type="button" className="bots-details-avatar" aria-label="Edit look" data-tooltip={editingLook ? undefined : "Edit look"} onClick={() => setEditingLook(!editingLook)}>
                <BotAvatar look={bot.look} size={104} lively track mood={typing ? "thinking" : undefined} pulse={pulses[bot.id]} />
                <span className="bots-details-pencil">
                  <Pencil size={14} />
                </span>
              </button>
            ) : (
              <span className="bots-details-avatar">
                <ConversationAvatar conversation={conversation} size={104} working={working} />
              </span>
            )}
            {bot && editingLook && <LookEditor bot={bot} onDone={() => setEditingLook(false)} />}
            {conversation.kind === "side" ? (
              <div className="bots-details-name bots-details-name-static">{name}</div>
            ) : (
              <InlineName value={conversation.friend ? (conversation.name ?? "") : name} onChange={(v) => (bot ? st.updateBot(bot.id, { name: v }, conversation.id) : st.updateConversation(conversation.id, { name: v }))} />
            )}
            <div className="bots-details-sub">
              {bot?.primary && <span className="bots-pill">Primary</span>}
              {bot
                ? `Made ${new Date(bot.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
                : conversation.friend
                  ? `Shared with ${conversation.friend.friendName}${conversation.friend.ended ? " · not syncing" : ""}`
                  : conversation.kind === "group"
                  ? `${conversation.botIds.length} bots`
                  : "Side chat between bots"}
            </div>
          </div>
          {bot ? (
            <>
              <Tabs
                tabs={[
                  ["instructions", "Instructions"],
                  ["routines", `Routines${bot.routines.length ? ` ${bot.routines.length}` : ""}`],
                  ["advanced", "Advanced"],
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === "instructions" && (
                <Instructions
                  value={bot.instructions}
                  placeholder="What is this bot for, and how should it act?"
                  hint="The bots write these as they learn what this one is for, and you can change them any time. It reads them before every reply."
                  onChange={(v) => st.updateBot(bot.id, { instructions: v })}
                />
              )}
              {tab === "routines" && <Routines bot={bot} />}
              {tab === "advanced" && <BotAdvanced bot={bot} />}
              <div className="bots-details-foot">
                <button
                  type="button"
                  className="btn btn-sm bots-danger"
                  disabled={bot.primary}
                  title={bot.primary ? "Make another bot primary first" : undefined}
                  onClick={() => openBotsDialog({ kind: "delete", id: conversation.id })}
                >
                  <Trash size={14} /> Delete bot
                </button>
              </div>
            </>
          ) : conversation.kind === "group" ? (
            <>
              <Tabs
                tabs={[
                  ["members", `Members ${conversation.botIds.length}`],
                  ["goal", "Goal"],
                  ["threads", `Threads${threads.length ? ` ${threads.length}` : ""}`],
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === "members" && <Members conversation={conversation} bots={bots} />}
              {tab === "threads" && <Threads threads={threads} bots={bots} open={openThread} />}
              {tab === "goal" && (
                <Instructions
                  value={conversation.instructions ?? ""}
                  placeholder="What is this group working on?"
                  hint="Every bot in the group reads this alongside its own instructions."
                  onChange={(v) => st.updateConversation(conversation.id, { instructions: v })}
                />
              )}
              <div className="bots-details-foot">
                <button type="button" className="btn btn-sm bots-danger" onClick={() => openBotsDialog({ kind: "delete", id: conversation.id })}>
                  <Trash size={14} /> Delete group
                </button>
              </div>
            </>
          ) : (
            <Members conversation={conversation} bots={bots} />
          )}
        </div>
      </div>
    </aside>
  );
}
