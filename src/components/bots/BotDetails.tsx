// OpenBots' details panel, beside the chat: a bot's look, name, instructions and routines; a group's members and goal; who's in a side chat.
import { Minus, Pencil, Plus, Trash, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BotLook } from "../../lib/bots/looks";
import { conversationName, directOf, useBots } from "../../lib/bots/store";
import type { Bot, Conversation } from "../../lib/bots/types";
import { cx, usePresence } from "../../lib/ui";
import { IconButton, Toggle } from "../primitives";
import { BotAvatar } from "./BotAvatar";
import { LookPicker } from "./BotDialogs";
import { openBotsDialog } from "./BotsSidebar";
import { ConversationAvatar } from "./common";

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
  const editable = conversation.kind === "group";
  const open = (bot: Bot) => {
    const c = directOf(useBots.getState().conversations, bot.id);
    if (c) st.select(c.id);
  };
  return (
    <div className="bots-pane">
      <ul className="bots-cards">
        {members.map((b) => (
          <li key={b.id} className="bots-card-row bots-member">
            <button type="button" className="bots-member-main" onClick={() => open(b)} data-tooltip="Open chat" data-tooltip-side="left">
              <BotAvatar look={b.look} size={28} />
              <span className="bots-card-text">{b.name}</span>
            </button>
            {editable && members.length > 2 && (
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
          <div className="bots-pane-label">Add to the group</div>
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
  const bots = useBots((s) => s.bots);
  const pulses = useBots((s) => s.pulses);
  const typing = useBots((s) => (s.typing[conversation.id]?.length ?? 0) > 0);
  const bot = conversation.kind === "direct" ? bots.find((b) => b.id === conversation.botIds[0]) : undefined;
  const [tab, setTab] = useState<"instructions" | "routines" | "members" | "goal">(conversation.kind === "direct" ? "instructions" : "members");
  const [editingLook, setEditingLook] = useState(false);
  const st = useBots.getState();
  useEffect(() => setTab(conversation.kind === "direct" ? "instructions" : "members"), [conversation.id, conversation.kind]);
  useEffect(() => setEditingLook(false), [conversation.id]);
  if (!mounted) return null;
  const name = conversationName(conversation, bots);
  const close = () => st.setDetailsOpen(false);
  return (
    <aside className={cx("bots-details", visible && "bots-details-open")} aria-label="Details">
      <div className="bots-details-inner">
        <div className="bots-details-top">
          <IconButton label="Close details" tooltipSide="left" onClick={close}>
            <X size={18} />
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
                <ConversationAvatar conversation={conversation} size={104} />
              </span>
            )}
            {bot && editingLook && <LookEditor bot={bot} onDone={() => setEditingLook(false)} />}
            {conversation.kind === "side" ? (
              <div className="bots-details-name bots-details-name-static">{name}</div>
            ) : (
              <InlineName value={name} onChange={(v) => (bot ? st.updateBot(bot.id, { name: v }) : st.updateConversation(conversation.id, { name: v }))} />
            )}
            <div className="bots-details-sub">
              {bot?.primary && <span className="bots-pill">Primary</span>}
              {bot
                ? `Made ${new Date(bot.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
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
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === "members" && <Members conversation={conversation} bots={bots} />}
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
