// Settings → Bots: every bot and group in one list, an editor for each (look, name, instructions,
// routines, model, how often it checks in; a group's members and goal), making and deleting
// them, the Claude logins they run on, the default model and web search providers they share, and how lively bots are.
import { MessageCircle, Plus, RotateCcw, Star, Trash2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { conversationName, directOf, useBots } from "../../lib/bots/store";
import type { Bot, Conversation, Proactivity } from "../../lib/bots/types";
import { useStore } from "../../lib/store";
import { cx } from "../../lib/ui";
import { OptionSelect } from "../ModelSelect";
import { SettingsBack, SettingsHeading } from "../primitives";
import { BotMachines, BotModel, BotModelSelect, DefaultFallbacks } from "./BotAdvanced";
import { BotAvatar, BotHuddle } from "./BotAvatar";
import { ConfirmDeleteDialog, CreateBotDialog, CreateGroupDialog, LookPicker } from "./BotDialogs";
import { Instructions, Members, Routines } from "./BotDetails";
import { useBusyBots } from "./common";
import { BotClaude } from "./BotClaude";
import { BotExtensions } from "./BotExtensions";
import { BotFriends } from "./BotFriends";
import { BotHarnesses, BotThreads } from "./BotThreads";
import { BotWebSearch } from "./BotWebSearch";

type Editing = { kind: "bot"; id: string } | { kind: "group"; id: string };
type Dialog = { kind: "bot" } | { kind: "group" } | { kind: "delete"; conversationId: string } | { kind: "reset" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Leave Settings for the conversation in OpenBots. */
function openChat(conversationId: string) {
  useBots.getState().select(conversationId);
  useStore.getState().closeSettings();
  useStore.getState().setBotsOpen(true);
}

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label className="md-label bots-set-label" htmlFor={htmlFor}>
      <span className="md-hash">#</span>
      {children}
    </label>
  );
}

const CHECK_INS: { value: Proactivity; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Every 8 hours" },
  { value: "normal", label: "Every 3 hours" },
  { value: "high", label: "Every hour" },
];

function BotEditor({ bot, onBack, onDelete }: { bot: Bot; onBack: () => void; onDelete: (conversationId: string) => void }) {
  const pulses = useBots((s) => s.pulses);
  const conversation = useBots((s) => directOf(s.conversations, bot.id));
  const st = useBots.getState();
  const [name, setName] = useState(bot.name);
  useEffect(() => setName(bot.name), [bot.name]);
  const saveName = () => {
    const next = name.trim();
    if (next && next !== bot.name) st.updateBot(bot.id, { name: next });
    else setName(bot.name);
  };
  return (
    <div className="bots-set-editor">
      <SettingsBack label="Back to all bots" onBack={onBack} />
      <div className="bots-set-hero">
        <BotAvatar look={bot.look} size={96} lively track playful pulse={pulses[bot.id]} />
        <div className="bots-set-hero-text">
          <input
            id="bot-name"
            className="input bots-set-name"
            value={name}
            maxLength={48}
            aria-label="Name"
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          <div className="bots-details-sub">
            {bot.primary && <span className="bots-pill">Primary</span>}
            Made {new Date(bot.createdAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
          </div>
          <div className="bots-set-hero-actions">
            {conversation && (
              <button type="button" className="btn btn-sm" onClick={() => openChat(conversation.id)}>
                <MessageCircle size={14} /> Open chat
              </button>
            )}
            {!bot.primary && (
              <button type="button" className="btn btn-sm" onClick={() => st.makePrimary(bot.id)}>
                <Star size={14} /> Make primary
              </button>
            )}
          </div>
        </div>
      </div>

      <section className="bots-set-block">
        <Label>Look</Label>
        <LookPicker
          look={bot.look}
          onChange={(look) => {
            st.updateBot(bot.id, { look });
            st.pulse(bot.id, "happy");
          }}
        />
      </section>
      <section className="bots-set-block">
        <Label>Instructions</Label>
        <Instructions
          value={bot.instructions}
          placeholder="What is this bot for, and how should it act?"
          hint="The bots write these as they learn what this one is for, and you can change them any time. It reads them before every reply."
          onChange={(v) => st.updateBot(bot.id, { instructions: v })}
        />
      </section>
      <section className="bots-set-block">
        <Label>Routines</Label>
        <Routines bot={bot} />
      </section>
      <section className="bots-set-block">
        <Label>Machines</Label>
        <BotMachines />
      </section>
      <section className="bots-set-block">
        <Label>OpenBuild</Label>
        <BotThreads bot={bot} />
      </section>
      <section className="bots-set-block">
        <Label>Usage</Label>
        <BotModel bot={bot} />
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">Check in on its own</div>
            <p className="setting-desc">How often it wakes up to see if anything's worth telling you, roughly, outside quiet hours. Each check uses its model. Messages and routines work either way.</p>
          </div>
          <OptionSelect label="Check in on its own" value={bot.proactivity ?? "normal"} options={CHECK_INS} onChange={(proactivity) => st.updateBot(bot.id, { proactivity })} />
        </div>
      </section>

      <div className="setting-row bots-set-danger">
        <div className="setting-text">
          <div className="setting-label">Delete bot</div>
          <p className="setting-desc">
            {bot.primary ? "This is your primary bot. Make another bot primary to delete it." : "Its memory, routines and conversation go too. Groups it's in carry on without it."}
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-danger" disabled={bot.primary || !conversation} onClick={() => conversation && onDelete(conversation.id)}>
          <Trash2 size={14} /> Delete
        </button>
      </div>
    </div>
  );
}

function GroupEditor({ group, onBack, onDelete }: { group: Conversation; onBack: () => void; onDelete: (conversationId: string) => void }) {
  const bots = useBots((s) => s.bots);
  const st = useBots.getState();
  const [name, setName] = useState(group.name ?? "");
  useEffect(() => setName(group.name ?? ""), [group.name]);
  const looks = group.botIds.map((id) => bots.find((b) => b.id === id)?.look ?? { shape: "orb", color: "gray" });
  const working = useBusyBots(group);
  const saveName = () => {
    const next = name.trim();
    if (next && next !== group.name) st.updateConversation(group.id, { name: next });
    else setName(group.name ?? "");
  };
  return (
    <div className="bots-set-editor">
      <SettingsBack label="Back to all bots" onBack={onBack} />
      <div className="bots-set-hero">
        <BotHuddle looks={looks} size={96} active={group.botIds.map((id) => working.includes(id))} />
        <div className="bots-set-hero-text">
          <input className="input bots-set-name" value={name} maxLength={48} aria-label="Group name" onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
          <div className="bots-details-sub">{plural(group.botIds.length, "bot")}</div>
          <div className="bots-set-hero-actions">
            <button type="button" className="btn btn-sm" onClick={() => openChat(group.id)}>
              <MessageCircle size={14} /> Open chat
            </button>
          </div>
        </div>
      </div>
      <section className="bots-set-block">
        <Label>Members</Label>
        <Members conversation={group} bots={bots} />
      </section>
      <section className="bots-set-block">
        <Label>Goal</Label>
        <Instructions
          value={group.instructions ?? ""}
          placeholder="What is this group working on?"
          hint="Every bot in the group reads this alongside its own instructions."
          onChange={(v) => st.updateConversation(group.id, { instructions: v })}
        />
      </section>
      <div className="setting-row bots-set-danger">
        <div className="setting-text">
          <div className="setting-label">Delete group</div>
          <p className="setting-desc">The group's conversation is deleted. The bots in it stay.</p>
        </div>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(group.id)}>
          <Trash2 size={14} /> Delete
        </button>
      </div>
    </div>
  );
}

function BotRow({ bot, onEdit }: { bot: Bot; onEdit: () => void }) {
  const conversation = useBots((s) => directOf(s.conversations, bot.id));
  const details = bot.routines.length ? plural(bot.routines.length, "routine") : "";
  return (
    <li className="pi-row bots-set-row">
      <button type="button" className="bots-set-row-main" onClick={onEdit}>
        <BotAvatar look={bot.look} size={34} />
        <span className="pi-row-text">
          <span className="pi-row-name">
            {bot.name}
            {bot.primary && <span className="bots-pill">Primary</span>}
            {conversation?.hidden && <span className="badge">hidden</span>}
          </span>
          <span className="pi-row-desc bots-set-row-desc">{bot.instructions || "No instructions yet"}</span>
        </span>
        {details && <span className="bots-set-row-meta">{details}</span>}
      </button>
      <span className="pi-row-actions">
        <button type="button" className="btn btn-sm" onClick={onEdit}>
          Edit
        </button>
      </span>
    </li>
  );
}

function GroupRow({ group, bots, onEdit }: { group: Conversation; bots: Bot[]; onEdit: () => void }) {
  const looks = group.botIds.map((id) => bots.find((b) => b.id === id)?.look ?? { shape: "orb", color: "gray" });
  const names = group.botIds.map((id) => bots.find((b) => b.id === id)?.name.split(" · ")[0]).filter(Boolean);
  const working = useBusyBots(group);
  return (
    <li className="pi-row bots-set-row">
      <button type="button" className="bots-set-row-main" onClick={onEdit}>
        <BotHuddle looks={looks} size={34} active={group.botIds.map((id) => working.includes(id))} />
        <span className="pi-row-text">
          <span className="pi-row-name">{conversationName(group, bots)}</span>
          <span className="pi-row-desc bots-set-row-desc">{names.join(", ") || "No bots"}</span>
        </span>
      </button>
      <span className="pi-row-actions">
        <button type="button" className="btn btn-sm" onClick={onEdit}>
          Edit
        </button>
      </span>
    </li>
  );
}

export function BotsSettingsSection() {
  const bots = useBots((s) => s.bots);
  const conversations = useBots((s) => s.conversations);
  const defaultModel = useBots((s) => s.defaultModel);
  const error = useBots((s) => s.error);
  // Saves show no progress; only a failed one is worth interrupting for.
  const syncStatus = error && <div className="bots-sync-status" role="alert">
    <span>{error}</span>
    <button type="button" className="btn bots-btn" onClick={() => useBots.getState().clearError()}>Dismiss</button>
  </div>;
  const [editing, setEditing] = useState<Editing>();
  const [dialog, setDialog] = useState<Dialog>();
  const st = useBots.getState();
  useEffect(() => st.ensureSeeded(), [st]);

  const groups = conversations.filter((c) => c.kind === "group").sort((a, b) => b.updatedAt - a.updatedAt);
  // Primary first, then oldest first: the order they were made in.
  const sorted = [...bots].sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || a.createdAt - b.createdAt);
  const editingBot = editing?.kind === "bot" ? bots.find((b) => b.id === editing.id) : undefined;
  const editingGroup = editing?.kind === "group" ? groups.find((g) => g.id === editing.id) : undefined;
  const deleting = dialog?.kind === "delete" ? conversations.find((c) => c.id === dialog.conversationId) : undefined;
  const closeDialog = () => setDialog(undefined);

  // Something that was being edited went away (deleted here or from the sidebar).
  useEffect(() => {
    if (editing && !editingBot && !editingGroup) setEditing(undefined);
  }, [editing, editingBot, editingGroup]);

  const dialogs = (
    <>
      {dialog?.kind === "bot" && (
        <CreateBotDialog
          onClose={closeDialog}
          onCreated={(id) => {
            const botId = useBots.getState().conversations.find((c) => c.id === id)?.botIds[0];
            if (botId) setEditing({ kind: "bot", id: botId });
          }}
        />
      )}
      {dialog?.kind === "group" && <CreateGroupDialog onClose={closeDialog} onCreated={(id) => setEditing({ kind: "group", id })} />}
      {deleting && (
        <ConfirmDeleteDialog
          title={`Delete “${conversationName(deleting, bots)}”?`}
          body={deleting.kind === "direct" ? "The bot, its memory, routines and conversation are deleted for good. Groups it's in carry on without it." : "The group's conversation is deleted for good. The bots in it stay."}
          onClose={closeDialog}
          onConfirm={() => {
            st.deleteConversation(deleting.id);
            setEditing(undefined);
          }}
        />
      )}
      {dialog?.kind === "reset" && (
        <ConfirmDeleteDialog
          title="Reset OpenBots?"
          body="Every bot, group and conversation is deleted, and the starter bots come back. This can't be undone."
          action={<><RotateCcw size={14} /> Reset</>}
          onClose={closeDialog}
          onConfirm={() => {
            st.reset();
            setEditing(undefined);
          }}
        />
      )}
    </>
  );

  if (editingBot)
    return (
      <>
        <SettingsHeading>Bots</SettingsHeading>
        {syncStatus}
        <BotEditor key={editingBot.id} bot={editingBot} onBack={() => setEditing(undefined)} onDelete={(conversationId) => setDialog({ kind: "delete", conversationId })} />
        {dialogs}
      </>
    );
  if (editingGroup)
    return (
      <>
        <SettingsHeading>Bots</SettingsHeading>
        {syncStatus}
        <GroupEditor key={editingGroup.id} group={editingGroup} onBack={() => setEditing(undefined)} onDelete={(conversationId) => setDialog({ kind: "delete", conversationId })} />
        {dialogs}
      </>
    );

  return (
    <>
      <SettingsHeading>Bots</SettingsHeading>
      {syncStatus}
      <p className="bots-set-intro">
        Bots keep their own instructions, memory and conversation with you, and work together in groups. Open them from the bot button at the bottom of the sidebar.
      </p>

      <section className="pi-block">
        <div className="pi-subhead">
          <h3>Your bots</h3>
          <button type="button" className="btn btn-sm" onClick={() => setDialog({ kind: "bot" })}>
            <Plus size={14} /> New bot
          </button>
        </div>
        <ul className="pi-list">
          {sorted.map((b) => (
            <BotRow key={b.id} bot={b} onEdit={() => setEditing({ kind: "bot", id: b.id })} />
          ))}
          {!sorted.length && <li className="pi-empty">No bots yet. Make one with New bot.</li>}
        </ul>
      </section>

      <section className="pi-block">
        <div className="pi-subhead">
          <h3>Groups</h3>
          <button type="button" className="btn btn-sm" disabled={bots.length < 2} title={bots.length < 2 ? "A group needs at least two bots" : undefined} onClick={() => setDialog({ kind: "group" })}>
            <UsersRound size={14} /> New group
          </button>
        </div>
        <ul className="pi-list">
          {groups.map((g) => (
            <GroupRow key={g.id} group={g} bots={bots} onEdit={() => setEditing({ kind: "group", id: g.id })} />
          ))}
          {!groups.length && <li className="pi-empty">No groups yet. A group puts a few bots in one chat to work on something together.</li>}
        </ul>
      </section>

      <section className="pi-block">
        <BotClaude />
      </section>

      <section className="pi-block">
        <div className="setting-row setting-row-stack">
          <div className="setting-text">
            <div className="setting-label">Default model</div>
            <p className="setting-desc">What every bot set to Default runs on. A bot with its own model keeps it. Changes apply from each bot's next reply.</p>
          </div>
          <BotModelSelect label="Default model" value={defaultModel} unset="Pi's default" onChange={st.setDefaultModel} />
        </div>
        <DefaultFallbacks />
      </section>

      <section className="pi-block">
        <BotWebSearch />
      </section>

      <section className="pi-block">
        <BotHarnesses />
      </section>

      <section className="pi-block">
        <BotExtensions />
      </section>

      <section className="pi-block">
        <BotFriends />
      </section>

      <section className="pi-block">
        <div className={cx("setting-row", "bots-set-danger")}>
          <div className="setting-text">
            <div className="setting-label">Reset OpenBots</div>
            <p className="setting-desc">Delete every bot, group and conversation, and start again from the starter bots.</p>
          </div>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog({ kind: "reset" })}>
            <RotateCcw size={14} /> Reset
          </button>
        </div>
      </section>
      {dialogs}
    </>
  );
}
