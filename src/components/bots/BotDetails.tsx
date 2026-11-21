// OpenBots' details panel, beside the chat: a bot's look, name, instructions, its tasks above its
// routines, the threads it has going from its chat, and its model, computer and OpenBuild permissions
// under Advanced; a group's members, goal (with its tasks) and routines; the working threads either started from its chat; who's in a
// side chat.
import { Archive, ArchiveRestore, ChevronLeft, Maximize2, Minus, Pencil, Plus, Timer, Trash, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { runningThreads, threadActivity, threadBrands } from "../../lib/bots/activity";
import type { BotLook } from "../../lib/bots/looks";
import { clampThreadWidth, loadThreadWidth, saveThreadWidth, THREAD_DEFAULT, THREAD_MIN, threadMax } from "../../lib/bots/threadWidth";
import { conversationName, directOf, useBots } from "../../lib/bots/store";
import type { Bot, Conversation, Routine } from "../../lib/bots/types";
import { countdown, formatRun } from "../../../shared/botSchedule";
import { botNameError, cleanRole, ROLE_MAX } from "../../../shared/bots";
import { closeBotsLayer, isPhone } from "../../lib/gestures";
import { useStore } from "../../lib/store";
import type { Chat } from "../../lib/types";
import { cx, useMediaQuery, usePresence } from "../../lib/ui";
import { useEdgeDrag } from "../FileTree";
import { LoadedChat } from "../LoadedChat";
import { ThreadPreview } from "../Workspace";
import { HermesMark, IconButton, ProviderIcon, RuntimeIcon, Toggle } from "../primitives";
import { expandBotsThread } from "../Sidebar";
import { BotAdvanced } from "./BotAdvanced";
import { BotAvatar } from "./BotAvatar";
import { LookPicker, NameError } from "./BotDialogs";
import { openBotsDialog } from "./BotsSidebar";
import { TodoList } from "./BotTodos";
import { ConversationAvatar, useBusyBots, useReading } from "./common";

/** `check`: why a name can't be used (another bot's), shown under the field, which stays open until it's changed or Escape. */
function InlineName({ value, check, onChange }: { value: string; check?: (name: string) => string | undefined; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const error = editing ? check?.(draft) : undefined;
  if (!editing)
    return (
      <button
        type="button"
        className="bots-details-name"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </button>
    );
  const commit = () => {
    if (error) return;
    if (draft.trim() && draft.trim() !== value) onChange(draft.trim());
    setEditing(false);
  };
  return (
    <>
      <input
        className="input bots-details-name-input"
        value={draft}
        maxLength={48}
        aria-label="Name"
        aria-invalid={!!error || undefined}
        aria-describedby={error ? "details-name-error" : undefined}
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
      <NameError id="details-name-error" error={error} />
    </>
  );
}

type Tab<T> = readonly [T, string];

/** The details' tabs: a plain row that never scrolls, its tabs shrinking to fit it (.bots-tabs). */
function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly Tab<T>[]; value: T; onChange: (t: T) => void }) {
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

/**
 * A bot's role: one line teammates see of it in their roster. Saved when the field is left or Enter is
 * pressed, not on every key: each change is a line in the bot's chat.
 */
export function RoleField({ bot, label }: { bot: Bot; label?: boolean }) {
  const saved = bot.role ?? "";
  const [draft, setDraft] = useState(saved);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(saved);
  }, [saved]);
  const commit = () => {
    const role = cleanRole(draft);
    setDraft(role);
    if (role !== saved) useBots.getState().updateBot(bot.id, { role });
  };
  return (
    <div className="bots-pane bots-role">
      {label && <span className="bots-pane-label">Role</span>}
      <input
        className="input bots-role-input"
        value={draft}
        maxLength={ROLE_MAX}
        placeholder="What this bot is for, in one line."
        aria-label="Role"
        onFocus={() => (focused.current = true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape" && draft !== saved) {
            e.stopPropagation();
            setDraft(saved);
          }
        }}
      />
      <p className="bots-hint">Teammates see this in their roster. Left empty, the first sentence of the instructions stands in.</p>
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

/**
 * A bot's routines, under where each reports: its chat with you first, then each group (its mascots and
 * name) or other chat. Kept to one list while they all report to its own chat. `label` heads them with
 * "Routines", for when something sits above them on the tab (its tasks).
 */
export function Routines({ bot, label }: { bot: Bot; label?: boolean }) {
  const conversations = useBots((s) => s.conversations);
  const bots = useBots((s) => s.bots);
  const head = label && <span className="bots-pane-label">Routines</span>;
  if (!bot.routines.length) return (
    <div className="bots-pane">
      {head}
      <p className="bots-hint">No routines yet. Ask {bot.name.split(" ·")[0]} in chat to set one up.</p>
    </div>
  );
  const direct = directOf(conversations, bot.id);
  const where = (r: Routine) => (r.conversationId && r.conversationId !== direct?.id ? r.conversationId : "");
  const order = (key: string) => (key ? (conversations.findIndex((c) => c.id === key) + 1 || conversations.length + 1) : 0);
  const keys = [...new Set(bot.routines.map(where))].sort((a, b) => order(a) - order(b));
  const list = (routines: Routine[]) => (
    <ul className="bots-cards">
      {routines.map((r) => (
        <RoutineRow key={r.id} bot={bot} routine={r} />
      ))}
    </ul>
  );
  if (keys.length === 1 && !keys[0]) return (
    <div className="bots-pane">
      {head}
      {list(bot.routines)}
    </div>
  );
  return (
    <div className="bots-pane">
      {head}
      {keys.map((key) => {
        const conversation = key ? conversations.find((c) => c.id === key) : direct;
        const routines = bot.routines.filter((r) => where(r) === key);
        return (
          <section key={key || "direct"} className="bots-routine-group" aria-label={conversation ? conversationName(conversation, bots) : "A chat that's gone"}>
            <div className="bots-routine-group-head">
              {conversation && <ConversationAvatar conversation={conversation} size={18} alive={false} badge={false} lineup />}
              <span className="bots-routine-group-name">{!key ? "Chat with you" : conversation ? conversationName(conversation, bots) : "A chat that's gone"}</span>
              <span className="bots-routine-group-count">{routines.length}</span>
            </div>
            {list(routines)}
          </section>
        );
      })}
    </div>
  );
}

/** A group's routines: those its bots set to report here, each with its bot's mascot and name. */
export function GroupRoutines({ conversation, bots }: { conversation: Conversation; bots: Bot[] }) {
  const rows = bots
    .flatMap((bot) => bot.routines.filter((r) => r.conversationId === conversation.id).map((routine) => ({ bot, routine })))
    .sort((a, b) => (a.routine.createdAt ?? 0) - (b.routine.createdAt ?? 0));
  return (
    <div className="bots-pane">
      {rows.length ? (
        <ul className="bots-cards">
          {rows.map(({ bot, routine }) => (
            <RoutineRow key={routine.id} bot={bot} routine={routine} owner />
          ))}
        </ul>
      ) : (
        <p className="bots-hint">No routines here yet. Ask a bot in the group to set one up, and it reports here.</p>
      )}
    </div>
  );
}

/** Now, again on every second while `on`: for a countdown. */
function useSeconds(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      setNow(Date.now());
      timer = setTimeout(step, 1000 - (Date.now() % 1000) + 5);
    };
    step();
    return () => clearTimeout(timer);
  }, [on]);
  return now;
}

/** When a routine runs next, counting down; paused, it says so. */
function RoutineCountdown({ routine: r }: { routine: Routine }) {
  const live = r.enabled && !!r.nextRunAt;
  const now = useSeconds(live);
  if (!r.enabled) return <span className="bots-routine-next bots-routine-paused">Paused</span>;
  if (!r.nextRunAt) return null;
  const left = countdown(r.nextRunAt - now);
  return (
    <span className="bots-routine-next" title={`Next run ${formatRun(r.nextRunAt, now)}`}>
      <Timer size={12} strokeWidth={2} aria-hidden />
      {left ? `Runs ${left}` : "Due now"}
    </span>
  );
}

/**
 * A routine, kept to a thin row: what it is, when, and how long until it runs, its switch, and Open (its
 * task) and Delete under that. `owner` shows whose it is, its mascot and name, among other bots'.
 */
function RoutineRow({ bot, routine: r, owner }: { bot: Bot; routine: Routine; owner?: boolean }) {
  const st = useBots.getState();
  const [open, setOpen] = useState(false);
  return (
    <li className={cx("bots-card-row bots-routine", !r.enabled && "bots-routine-off")} data-bot={owner ? bot.id : undefined}>
      {owner && (
        <span className="bots-routine-owner">
          <BotAvatar look={bot.look} size={28} alive={false} label={bot.name} />
        </span>
      )}
      <span className="bots-card-text">
        <span className="bots-routine-title" title={r.title}>{r.title}</span>
        <span className="bots-routine-when">
          {owner && <><span className="bots-routine-bot">{bot.name}</span> · </>}
          {r.schedule}
        </span>
        <RoutineCountdown routine={r} />
        {open && r.task && <span className="bots-routine-task">{r.task}</span>}
      </span>
      <span className="bots-routine-side">
        {/* A retired bot's routines stay paused: they turn on again here once it's rehired. */}
        <span title={bot.retiredAt ? "Paused while it's retired. Rehire it to turn this on." : undefined}>
          <Toggle checked={r.enabled} disabled={!!bot.retiredAt} label={r.enabled ? "Pause" : "Resume"} onChange={(on) => st.updateRoutine(bot.id, r.id, { enabled: on })} />
        </span>
        <span className="bots-routine-actions">
          {r.task && (
            <button type="button" className="bots-routine-action" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Close" : "Open"}
            </button>
          )}
          <button type="button" className="bots-routine-action bots-routine-delete" onClick={() => st.removeRoutine(bot.id, r.id)}>
            Delete
          </button>
        </span>
      </span>
    </li>
  );
}

export function Members({ conversation, bots }: { conversation: Conversation; bots: Bot[] }) {
  const st = useBots.getState();
  const members = conversation.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  // A retired bot can't be added: it comes back to the groups it left when it's rehired.
  const others = bots.filter((b) => !conversation.botIds.includes(b.id) && !b.retiredAt);
  const away = conversation.kind === "group" ? bots.filter((b) => b.retiredAt && b.retiredFrom?.includes(conversation.id)) : [];
  const shared = conversation.friend;
  // A shared chat that stopped syncing is there to read; its members don't change anymore.
  const editable = conversation.kind === "group" && !shared?.ended;
  // A group keeps two bots; a shared chat can be down to none of yours, since the friend's are there too.
  const removable = shared ? members.length > 0 : members.length > 2;
  // As in the group's huddle: awake at work, dozing otherwise.
  const working = useBusyBots(conversation);
  const readers = useReading(conversation.botIds);
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
                  <BotAvatar look={m.look ?? { shape: "blob", color: "gray" }} size={28} alive={false} />
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
        {shared && !members.length && <li className="bots-hint">None of your bots yet. Add one below; it answers when mentioned.</li>}
        {members.map((b) => (
          <li key={b.id} className="bots-card-row bots-member">
            <button type="button" className="bots-member-main" onClick={() => open(b)}>
              <BotAvatar look={b.look} size={28} busy={working.includes(b.id)} reading={readers[conversation.botIds.indexOf(b.id)]} asleep={!working.includes(b.id)} zzz />
              <span className="bots-card-text">{b.name}</span>
            </button>
            {editable && removable && (
              <IconButton
                label="Remove from group"
                tooltip={false}
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
        {away.map((b) => (
          <li key={b.id} className="bots-card-row bots-member bots-member-retired">
            <button type="button" className="bots-member-main" onClick={() => open(b)}>
              <BotAvatar look={b.look} size={28} alive={false} />
              <span className="bots-card-text">{b.name}</span>
            </button>
            <span className="bots-pill bots-retired-pill" title="It rejoins this group when it's rehired">Retired</span>
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
                  tooltip={false}
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
 * The coding threads this chat's bots started from it that are working now, with the bot that started
 * each (runningThreads). Threads started before chats recorded it are found by the chat's "Started a
 * thread" activity, while it's still loaded.
 */
function useConversationThreads(conversation: Conversation): { chat: Chat; bot: string }[] {
  const chats = useStore((s) => s.chats);
  const { id, messages } = conversation;
  return useMemo(() => runningThreads({ id, messages }, chats), [chats, id, messages]);
}

/** The harness a thread runs on, then the provider behind its model: two marks, each named in its tooltip. */
function ThreadBrands({ chat }: { chat: Chat }) {
  const { runtime, harness, provider } = threadBrands(chat);
  return (
    <span className="bots-thread-brands">
      <span className="bots-thread-brand" role="img" aria-label={harness} data-tooltip={harness}>
        <RuntimeIcon runtime={runtime} size={14} />
      </span>
      {provider && (
        <span className="bots-thread-brand" role="img" aria-label={provider.name} data-tooltip={provider.name}>
          {provider.id === "hermes" ? <HermesMark size={14} /> : <ProviderIcon provider={provider.id} />}
        </span>
      )}
    </span>
  );
}

/** A row opens its thread inside this panel (ThreadPane), with Back returning to this list. */
function Threads({ threads, bots, open, empty }: { threads: { chat: Chat; bot: string }[]; bots: Bot[]; open: (id: string) => void; empty: React.ReactNode }) {
  if (!threads.length) return <div className="bots-pane"><p className="bots-hint">{empty}</p></div>;
  return (
    <div className="bots-pane">
      <ul className="bots-cards">
        {threads.map(({ chat, bot: id }) => {
          const bot = bots.find((b) => b.id === id);
          const activity = threadActivity(chat);
          return (
            <li key={chat.id} className="bots-card-row bots-member">
              <button type="button" className="bots-member-main" onClick={() => open(chat.id)}>
                {/* Only whose thread it is: a still mascot, whatever its bot is doing. */}
                {bot && <BotAvatar look={bot.look} size={28} alive={false} />}
                <span className="bots-card-text">
                  <span className="bots-routine-title">{chat.title}</span>
                  <span className="bots-routine-when">{[bot?.name, chat.workspace?.projectName, activity === "waiting" && "Waiting for you"].filter(Boolean).join(" · ")}</span>
                </span>
                <ThreadBrands chat={chat} />
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

/**
 * A coding thread inside the details panel, in place of its tabs, which stay mounted underneath. Opened
 * by a link in the chat with the panel closed, it `closes` the panel instead of going back to the list,
 * with an X: on a phone that's straight back to the chat.
 */
function ThreadPane({ chat, phone, back, closes, size }: { chat: Chat; phone: boolean; back: () => void; closes?: () => void; size: ReturnType<typeof useThreadWidth> }) {
  return (
    <div className="bots-details-threadpane">
      {!phone && <ThreadGrip {...size} />}
      <div className="bots-details-top bots-details-thread-top">
        {closes ? (
          <IconButton label="Close thread" tooltip={false} onClick={closes}>
            <X size={phone ? 24 : 18} />
          </IconButton>
        ) : (
          <IconButton label="Back to threads" tooltip={false} onClick={back}>
            <ChevronLeft size={phone ? 26 : 18} />
          </IconButton>
        )}
        <span className="bots-details-thread-title">{chat.title}</span>
        <IconButton label="Open in OpenBuild" tooltipSide="left" onClick={() => {
          useStore.setState({ activeChatId: chat.id, searchFocus: undefined, botsThread: false });
          expandBotsThread();
        }}>
          <Maximize2 size={16} />
        </IconButton>
      </div>
      <div className="bots-details-thread">
        <ThreadPreview.Provider value>
          <LoadedChat key={chat.id} chat={chat} />
        </ThreadPreview.Provider>
      </div>
    </div>
  );
}

type DetailsTab = "instructions" | "routines" | "advanced" | "members" | "goal" | "threads";

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
  const working = useBusyBots(conversation);
  const bot = conversation.kind === "direct" ? bots.find((b) => b.id === conversation.botIds[0]) : undefined;
  const [tab, setTab] = useState<DetailsTab>(conversation.kind === "direct" ? "instructions" : "members");
  const [editingLook, setEditingLook] = useState(false);
  const threads = useConversationThreads(conversation);
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
  // A thread a link in the chat opened with the panel closed: what the panel showed before, to leave it
  // that way once it's closed again, by the thread's X or any other way.
  const [before, setBefore] = useState<{ tab: DetailsTab; thread?: string }>();
  const [threadFor, setThreadFor] = useState(conversation.id);
  if (threadFor !== conversation.id) {
    setThreadFor(conversation.id);
    setThreadId(undefined);
    setBefore(undefined);
  }
  // Asked for a tab: the header's task progress opens a bot's Routines, its list above them, or the
  // group's Goal, where its list is; a routine line in the chat opens the Routines, the bot's or the
  // group's (EventLine); a link in the chat to a thread still running opens that thread, under Threads.
  const asked = useBots((s) => s.detailsTab);
  const [askedKey, setAskedKey] = useState(asked?.key);
  if (asked && asked.key !== askedKey) {
    setAskedKey(asked.key);
    setBefore(asked.tab === "threads" && asked.closes ? { tab, thread: threadId } : undefined);
    if (asked.tab === "threads") {
      setTab("threads");
      setThreadId(asked.thread);
    } else if (asked.tab === "goal" ? conversation.kind === "group" : conversation.kind !== "side") setTab(asked.tab);
  }
  const threadChat = useStore((s) => (threadId ? s.chats.find((c) => c.id === threadId) : undefined));
  const panel = useRef<HTMLElement>(null);
  const size = useThreadWidth(panel, mounted);
  const showing = !!threadChat && tab === "threads";
  const back = () => {
    setBefore(undefined);
    setThreadId(undefined);
  };
  const close = () => (phone ? closeBotsLayer("details") : st.setDetailsOpen(false));
  const closes = before ? close : undefined;
  // Closed, and done sliding away (reopened before then, it's still the thread), the panel goes back to
  // how it was before the link opened the thread.
  useEffect(() => {
    if (open || mounted || !before) return;
    setTab(before.tab);
    setThreadId(before.thread);
    setBefore(undefined);
  }, [open, mounted, before]);
  const openThread = (id: string) => {
    setThreadId(id);
    if (useStore.getState().chats.find((c) => c.id === id)?.unread) useStore.getState().updateChat(id, { unread: false });
  };
  // Escape steps back to the list first, like Back, before BotsView's takes the panel itself. Or, like
  // the X, it closes a thread a link opened with the panel closed.
  const escape = useRef(back);
  escape.current = closes ?? back;
  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229 || useStore.getState().settingsOpen) return;
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest("[role='menu'], [role='listbox'], [role='dialog'], dialog")) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !el.classList.contains("composer-input")) return;
      e.preventDefault();
      escape.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showing]);
  if (!mounted) return null;
  const name = conversationName(conversation, bots);
  return (
    <aside ref={panel} className={cx("bots-details", visible && "bots-details-open", showing && "bots-details-wide")} style={{ "--thread-w": `${size.width}px` } as React.CSSProperties} aria-label="Details">
      {showing && <ThreadPane chat={threadChat} phone={phone} back={back} closes={closes} size={size} />}
      <div className="bots-details-inner" hidden={showing}>
        <div className="bots-details-top">
          <IconButton label="Close details" tooltip={false} onClick={close}>
            {phone ? <ChevronLeft size={26} /> : <X size={18} />}
          </IconButton>
        </div>
        <div className="bots-details-scroll">
          <div className="bots-details-hero">
            {bot ? (
              <button type="button" className="bots-details-avatar" aria-label="Edit look" onClick={() => setEditingLook(!editingLook)}>
                {/* Only following the pointer about the panel, and at rest otherwise: none of a bot's
                    life, faces or reactions here. */}
                <BotAvatar look={bot.look} size={104} alive={false} track trackWithin=".bots-details" />
                <span className="bots-details-pencil">
                  <Pencil size={14} />
                </span>
              </button>
            ) : (
              <span className="bots-details-avatar">
                <ConversationAvatar conversation={conversation} size={104} working={working} zzz />
              </span>
            )}
            {bot && editingLook && <LookEditor bot={bot} onDone={() => setEditingLook(false)} />}
            {conversation.kind === "side" ? (
              <div className="bots-details-name bots-details-name-static">{name}</div>
            ) : (
              <InlineName value={conversation.friend ? (conversation.name ?? "") : name} check={bot && ((v) => botNameError(bots, v, bot))} onChange={(v) => (bot ? st.updateBot(bot.id, { name: v }, conversation.id) : st.updateConversation(conversation.id, { name: v }))} />
            )}
            {bot ? (
              (bot.primary || bot.retiredAt) && (
                <div className="bots-details-sub">
                  {bot.primary && <span className="bots-pill">Primary</span>}
                  {bot.retiredAt && <span className="bots-pill bots-retired-pill">Retired</span>}
                </div>
              )
            ) : (
              <div className="bots-details-sub">
                {conversation.friend
                  ? `Shared with ${conversation.friend.friendName}${conversation.friend.ended ? " · not syncing" : ""}`
                  : conversation.kind === "group"
                    ? `${conversation.botIds.length} bots`
                    : "Side chat between bots"}
              </div>
            )}
          </div>
          {bot ? (
            <>
              <Tabs
                tabs={[
                  ["instructions", "Instructions"],
                  ["routines", "Routines"],
                  ["threads", "Threads"],
                  ["advanced", "Advanced"],
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === "instructions" && (
                <>
                  <RoleField key={bot.id} bot={bot} label />
                  <Instructions
                    value={bot.instructions}
                    placeholder="What is this bot for, and how should it act?"
                    hint="Read before every reply. The bot updates these as it learns, and you can edit them any time."
                    onChange={(v) => st.updateBot(bot.id, { instructions: v })}
                  />
                </>
              )}
              {tab === "routines" &&
                // Its to-do list, above the routines, only while it has one.
                (conversation.todos?.length ? (
                  <>
                    <div className="bots-pane bots-tasks-pane">
                      <TodoList conversation={conversation} bots={bots} />
                    </div>
                    <Routines bot={bot} label />
                  </>
                ) : (
                  <Routines bot={bot} />
                ))}
              {tab === "advanced" && <BotAdvanced bot={bot} />}
              {tab === "threads" && (
                <Threads
                  threads={threads}
                  bots={bots}
                  open={openThread}
                  empty={
                    // Without "Run coding agents" it can't start any: say where that's turned on.
                    bot.threads?.enabled ? (
                      "No threads running. Threads it starts from this chat show up here until they finish."
                    ) : (
                      <>
                        No threads running. To let it start them, turn on Run coding agents under{" "}
                        <button type="button" className="link" onClick={() => setTab("advanced")}>
                          Advanced
                        </button>
                        .
                      </>
                    )
                  }
                />
              )}
              {/* A bot is retired first; deleting it for good is only offered once it is. */}
              {bot.retiredAt ? (
                <div className="bots-details-foot bots-details-foot-retired">
                  <button type="button" className="btn btn-sm" onClick={() => st.rehireBot(bot.id)}>
                    <ArchiveRestore size={14} /> Rehire
                  </button>
                  <button type="button" className="btn btn-sm bots-danger bots-delete" onClick={() => openBotsDialog({ kind: "delete", id: conversation.id })}>
                    <Trash size={14} /> Delete permanently
                  </button>
                </div>
              ) : (
                <div className="bots-details-foot">
                  <button
                    type="button"
                    className="btn btn-sm bots-retire"
                    disabled={bot.primary}
                    title={bot.primary ? "Make another bot primary first" : undefined}
                    onClick={() => openBotsDialog({ kind: "retire", id: conversation.id })}
                  >
                    <Archive size={14} /> Retire bot
                  </button>
                </div>
              )}
            </>
          ) : conversation.kind === "group" ? (
            <>
              <Tabs
                tabs={[
                  ["members", `Members ${conversation.botIds.length}`],
                  ["goal", "Goal"],
                  ["routines", "Routines"],
                  ["threads", "Threads"],
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === "members" && <Members conversation={conversation} bots={bots} />}
              {tab === "routines" && <GroupRoutines conversation={conversation} bots={bots} />}
              {tab === "threads" && <Threads threads={threads} bots={bots} open={openThread} empty="No threads running. Threads the bots here start show up until they finish." />}
              {tab === "goal" && (
                <>
                  <Instructions
                    value={conversation.instructions ?? ""}
                    placeholder="What is this group working on?"
                    hint="Every bot in the group reads this alongside its own instructions."
                    onChange={(v) => st.updateConversation(conversation.id, { instructions: v })}
                  />
                  <TodoList conversation={conversation} bots={bots} />
                </>
              )}
              <div className="bots-details-foot">
                <button type="button" className="btn btn-sm bots-danger bots-delete" onClick={() => openBotsDialog({ kind: "delete", id: conversation.id })}>
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
