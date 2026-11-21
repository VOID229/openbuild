// Settings → Bots: every bot and group in one list, each opening a page of its own (look, name,
// instructions, routines, model, how often it checks in; a group's members and goal), making and
// deleting them, and pages for what they share: their models, the Claude logins they run on, web
// search, the harnesses they may start threads on, extra Pi extensions, and friends.
import { Archive, ArchiveRestore, ChevronRight, MessageCircle, RotateCcw, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { botNameError } from "../../../shared/bots";
import { conversationName, directOf, useBots } from "../../lib/bots/store";
import type { Bot, Conversation, Proactivity } from "../../lib/bots/types";
import { useBotModels } from "../../lib/bots/models";
import { useStore } from "../../lib/store";
import { cx } from "../../lib/ui";
import { OptionSelect } from "../ModelSelect";
import { openSettingsPage, settingsUp } from "../../lib/pages";
import { SettingsHeading } from "../primitives";
import { NavRow, SettingsGroup, SubPage } from "../SettingsUI";
import { BotMachines, BotModel, BotModelSelect, BotWorksIn, DefaultFallbacks, WORKS_IN_DESC } from "./BotAdvanced";
import { BotAvatar, BotHuddle } from "./BotAvatar";
import { ConfirmDeleteDialog, DeleteBotDialog, LookPicker, NameError, RetireBotDialog } from "./BotDialogs";
import { Instructions, Members, RoleField, Routines } from "./BotDetails";
import { useBusyBots } from "./common";
import { BotClaude } from "./BotClaude";
import { BotExtensions, useExtensionsSummary } from "./BotExtensions";
import { BotFriends } from "./BotFriends";
import { BotHarnesses, BotThreads, useAllowedHarnesses } from "./BotThreads";
import { BotWebSearch, useConfiguredProviders } from "./BotWebSearch";

type Dialog = { kind: "delete"; conversationId: string } | { kind: "retire"; botId: string } | { kind: "reset" };

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

function BotEditor({ bot, onDelete, onRetire }: { bot: Bot; onDelete: (conversationId: string) => void; onRetire: (botId: string) => void }) {
  const pulses = useBots((s) => s.pulses);
  const conversation = useBots((s) => directOf(s.conversations, bot.id));
  const st = useBots.getState();
  const bots = useBots((s) => s.bots);
  const [name, setName] = useState(bot.name);
  useEffect(() => setName(bot.name), [bot.name]);
  const error = botNameError(bots, name, bot);
  // A name another bot has stays in the field, with why under it, until it's changed.
  const saveName = () => {
    const next = name.trim();
    if (error) return;
    if (next && next !== bot.name) st.updateBot(bot.id, { name: next });
    else setName(bot.name);
  };
  return (
    <SubPage title={bot.name} trail={["Bots"]} className="bots-set-editor">
      <div className="bots-set-hero">
        <BotAvatar look={bot.look} size={72} lively track playful pulse={pulses[bot.id]} />
        <div className="bots-set-hero-text">
          <input
            id="bot-name"
            className="input bots-set-name"
            value={name}
            maxLength={48}
            aria-label="Name"
            aria-invalid={!!error || undefined}
            aria-describedby={error ? "bot-name-error" : undefined}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape" && name !== bot.name) {
                e.stopPropagation();
                setName(bot.name);
              }
            }}
          />
          <NameError id="bot-name-error" error={error} />
          {(bot.primary || bot.retiredAt) && (
            <div className="bots-details-sub">
              {bot.primary && <span className="bots-pill">Primary</span>}
              {bot.retiredAt && <span className="bots-pill bots-retired-pill">Retired</span>}
            </div>
          )}
          <div className="bots-set-hero-actions">
            {conversation && (
              <button type="button" className="btn btn-sm" onClick={() => openChat(conversation.id)}>
                <MessageCircle size={14} /> Open chat
              </button>
            )}
            {!bot.primary && !bot.retiredAt && (
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
        <Label>Role</Label>
        <RoleField key={bot.id} bot={bot} />
      </section>
      <section className="bots-set-block">
        <Label>Instructions</Label>
        <Instructions
          value={bot.instructions}
          placeholder="What is this bot for, and how should it act?"
          hint="Read before every reply. The bot updates these as it learns, and you can edit them any time."
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
            <p className="setting-desc">How often it checks whether anything's worth telling you, outside quiet hours. Each check uses its model.</p>
          </div>
          <OptionSelect label="Check in on its own" value={bot.proactivity ?? "normal"} options={CHECK_INS} onChange={(proactivity) => st.updateBot(bot.id, { proactivity })} />
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <div className="setting-label">Works in</div>
            <p className="setting-desc">{WORKS_IN_DESC}</p>
          </div>
          <BotWorksIn bot={bot} />
        </div>
      </section>

      {bot.retiredAt ? (
        <>
          <div className="setting-row bots-set-danger">
            <div className="setting-text">
              <div className="setting-label">Rehire</div>
              <p className="setting-desc">It comes back as it was, in the groups it left. Its routines stay paused until you turn them on, and your other bots are told it's back.</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => st.rehireBot(bot.id)}>
              <ArchiveRestore size={14} /> Rehire
            </button>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-label">Delete permanently</div>
              <p className="setting-desc">Its memory, instructions, routines and conversation are deleted for good. It can't be rehired after this.</p>
            </div>
            <button type="button" className="btn btn-sm btn-danger" disabled={!conversation} onClick={() => conversation && onDelete(conversation.id)}>
              <Trash2 size={14} /> Delete permanently
            </button>
          </div>
        </>
      ) : (
        <div className="setting-row bots-set-danger">
          <div className="setting-text">
            <div className="setting-label">Retire bot</div>
            <p className="setting-desc">
              {bot.primary
                ? "This is your primary bot. Make another bot primary to retire it."
                : "A pause you can undo. It keeps its memory, instructions and routines, but can't be mentioned or used until you rehire it. Only a retired bot can be deleted."}
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-calm" disabled={bot.primary} onClick={() => onRetire(bot.id)}>
            <Archive size={14} /> Retire
          </button>
        </div>
      )}
    </SubPage>
  );
}

function GroupEditor({ group, onDelete }: { group: Conversation; onDelete: (conversationId: string) => void }) {
  const bots = useBots((s) => s.bots);
  const st = useBots.getState();
  const [name, setName] = useState(group.name ?? "");
  useEffect(() => setName(group.name ?? ""), [group.name]);
  const looks = group.botIds.map((id) => bots.find((b) => b.id === id)?.look ?? { shape: "blob", color: "gray" });
  const working = useBusyBots(group);
  const saveName = () => {
    const next = name.trim();
    if (next && next !== group.name) st.updateConversation(group.id, { name: next });
    else setName(group.name ?? "");
  };
  return (
    <SubPage title={group.name || "Group"} trail={["Bots"]} className="bots-set-editor">
      <div className="bots-set-hero">
        <BotHuddle looks={looks} size={72} active={group.botIds.map((id) => working.includes(id))} />
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
    </SubPage>
  );
}

function BotRow({ bot }: { bot: Bot }) {
  const conversation = useBots((s) => directOf(s.conversations, bot.id));
  const details = bot.routines.length ? plural(bot.routines.length, "routine") : "";
  return (
    <li className="pi-row bots-set-row">
      <button type="button" className="bots-set-row-main" aria-label={bot.name} onClick={() => openSettingsPage(`bot/${encodeURIComponent(bot.id)}`)}>
        <BotAvatar look={bot.look} size={28} />
        <span className="pi-row-text">
          <span className="pi-row-name">
            {bot.name}
            {bot.primary && <span className="bots-pill">Primary</span>}
            {bot.retiredAt && <span className="bots-pill bots-retired-pill">Retired</span>}
            {conversation?.hidden && <span className="badge">hidden</span>}
          </span>
          <span className="pi-row-desc bots-set-row-desc">{bot.role || bot.instructions || "No instructions yet"}</span>
        </span>
        {details && <span className="bots-set-row-meta">{details}</span>}
        <ChevronRight size={16} className="nav-row-chevron" aria-hidden />
      </button>
    </li>
  );
}

function GroupRow({ group, bots }: { group: Conversation; bots: Bot[] }) {
  const looks = group.botIds.map((id) => bots.find((b) => b.id === id)?.look ?? { shape: "blob", color: "gray" });
  const names = group.botIds.map((id) => bots.find((b) => b.id === id)?.name.split(" · ")[0]).filter(Boolean);
  const working = useBusyBots(group);
  return (
    <li className="pi-row bots-set-row">
      <button type="button" className="bots-set-row-main" aria-label={conversationName(group, bots)} onClick={() => openSettingsPage(`group/${encodeURIComponent(group.id)}`)}>
        <BotHuddle looks={looks} size={28} active={group.botIds.map((id) => working.includes(id))} />
        <span className="pi-row-text">
          <span className="pi-row-name">{conversationName(group, bots)}</span>
          <span className="pi-row-desc bots-set-row-desc">{names.join(", ") || "No bots"}</span>
        </span>
        <ChevronRight size={16} className="nav-row-chevron" aria-hidden />
      </button>
    </li>
  );
}

/** Settings → Bots → Models: the default model and fallbacks every bot follows, and each bot's own model. */
function BotModels({ bots }: { bots: Bot[] }) {
  const defaultModel = useBots((s) => s.defaultModel);
  const st = useBots.getState();
  return (
    <SubPage title="Models" trail={["Bots"]}>
      <div className="setting-row setting-row-stack">
        <div className="setting-text">
          <div className="setting-label">Default model</div>
          <p className="setting-desc">Used by every bot set to Default.</p>
        </div>
        <BotModelSelect label="Default model" value={defaultModel} unset="Pi's default" onChange={st.setDefaultModel} />
      </div>
      <DefaultFallbacks />
      <SettingsGroup title="Per bot">
        {bots.map((b) => (
          <div key={b.id} className="setting-row bots-set-model-row">
            <div className="setting-text bots-set-model-name">
              <BotAvatar look={b.look} size={22} />
              <span className="setting-label">{b.name}</span>
            </div>
            <BotModelSelect label={`Model for ${b.name}`} value={b.model} unset="Default" inherited={defaultModel} onChange={(model) => st.updateBot(b.id, { model })} />
          </div>
        ))}
      </SettingsGroup>
      <p className="field-help">A bot's effort and its own fallbacks are on its page.</p>
    </SubPage>
  );
}

export function BotsSettingsSection() {
  const bots = useBots((s) => s.bots);
  const conversations = useBots((s) => s.conversations);
  const loaded = useBots((s) => s.loaded);
  const defaultModel = useBots((s) => s.defaultModel);
  const error = useBots((s) => s.error);
  const page = useStore((s) => s.settingsPage);
  const searching = useConfiguredProviders();
  const harnesses = useAllowedHarnesses();
  const extensions = useExtensionsSummary();
  const { listing } = useBotModels();
  // Saves show no progress; only a failed one is worth interrupting for.
  const syncStatus = error && <div className="bots-sync-status" role="alert">
    <span>{error}</span>
    <button type="button" className="btn bots-btn" onClick={() => useBots.getState().clearError()}>Dismiss</button>
  </div>;
  const [dialog, setDialog] = useState<Dialog>();
  const st = useBots.getState();
  useEffect(() => st.ensureSeeded(), [st]);

  const groups = conversations.filter((c) => c.kind === "group").sort((a, b) => b.updatedAt - a.updatedAt);
  // Primary first, then oldest first: the order they were made in. Retired ones come last, marked.
  const sorted = [...bots].sort((a, b) => Number(!!a.retiredAt) - Number(!!b.retiredAt) || Number(!!b.primary) - Number(!!a.primary) || a.createdAt - b.createdAt);
  // A bot's or a group's page: settings/bots/bot/<id>, settings/bots/group/<id>.
  const [kind, rawId] = page?.split("/") ?? [];
  const id = rawId && decodeURIComponent(rawId);
  const editingBot = kind === "bot" ? bots.find((b) => b.id === id) : undefined;
  const editingGroup = kind === "group" ? groups.find((g) => g.id === id) : undefined;
  const deleting = dialog?.kind === "delete" ? conversations.find((c) => c.id === dialog.conversationId) : undefined;
  // A bot's page asks to delete its chat: that's the bot, for good, and only once it's retired.
  const deletingBot = deleting?.kind === "direct" ? bots.find((b) => b.id === deleting.botIds[0]) : undefined;
  const retiring = dialog?.kind === "retire" ? bots.find((b) => b.id === dialog.botId && !b.retiredAt) : undefined;
  const closeDialog = () => setDialog(undefined);

  // Something that was being edited went away (deleted here or from the sidebar).
  useEffect(() => {
    if (loaded && (kind === "bot" || kind === "group") && !editingBot && !editingGroup) useStore.setState({ settingsPage: undefined });
  }, [loaded, kind, editingBot, editingGroup]);

  const dialogs = (
    <>
      {retiring && <RetireBotDialog bot={retiring} onClose={closeDialog} />}
      {deletingBot && (deletingBot.retiredAt ? <DeleteBotDialog bot={deletingBot} onClose={closeDialog} onDone={() => useStore.getState().settingsPage && settingsUp()} /> : <RetireBotDialog bot={deletingBot} onClose={closeDialog} />)}
      {deleting && !deletingBot && (
        <ConfirmDeleteDialog
          title={`Delete “${conversationName(deleting, bots)}”?`}
          body="The group's conversation is deleted for good. The bots in it stay."
          onClose={closeDialog}
          onConfirm={() => {
            st.deleteConversation(deleting.id);
            if (useStore.getState().settingsPage) settingsUp();
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
          }}
        />
      )}
    </>
  );
  const onDelete = (conversationId: string) => setDialog({ kind: "delete", conversationId });
  const onRetire = (botId: string) => setDialog({ kind: "retire", botId });

  const shared: Record<string, [string, React.ReactNode]> = {
    models: ["Models", null],
    claude: ["Claude", <BotClaude />],
    search: ["Web search", <BotWebSearch />],
    harnesses: ["Harnesses", <BotHarnesses />],
    extensions: ["Custom extensions", <BotExtensions />],
    friends: ["Friends", <BotFriends />],
  };
  const body = editingBot ? (
    <BotEditor key={editingBot.id} bot={editingBot} onDelete={onDelete} onRetire={onRetire} />
  ) : editingGroup ? (
    <GroupEditor key={editingGroup.id} group={editingGroup} onDelete={onDelete} />
  ) : page === "models" ? (
    <BotModels bots={sorted} />
  ) : page && shared[page] ? (
    <SubPage title={shared[page][0]} trail={["Bots"]}>{shared[page][1]}</SubPage>
  ) : undefined;
  if (body)
    return (
      <>
        {syncStatus}
        {body}
        {dialogs}
      </>
    );

  const modelName = defaultModel ? (listing?.models.find((m) => m.id === defaultModel)?.name ?? defaultModel) : "Pi's default";
  return (
    <>
      <SettingsHeading>Bots</SettingsHeading>
      {syncStatus}

      {/* Bots and groups are made from the sidebar's "+" (BotsSidebar.tsx). */}
      <SettingsGroup title="Your bots">
        <ul className="pi-list">
          {sorted.map((b) => (
            <BotRow key={b.id} bot={b} />
          ))}
          {!sorted.length && <li className="pi-empty">No bots yet.</li>}
        </ul>
      </SettingsGroup>

      <SettingsGroup title="Groups">
        <ul className="pi-list">
          {groups.map((g) => (
            <GroupRow key={g.id} group={g} bots={bots} />
          ))}
          {!groups.length && <li className="pi-empty">No groups yet.</li>}
        </ul>
      </SettingsGroup>

      <SettingsGroup title="Shared by every bot" className="sgroup-rows">
        <NavRow label="Models" value={modelName} to="models" />
        <NavRow label="Claude" desc="Run bots on your Claude plan." to="claude" />
        <NavRow label="Web search" value={searching.length ? searching.join(", ") : "No keys yet"} to="search" />
        <NavRow label="Harnesses" desc="Where bots may start OpenBuild threads." value={harnesses.length ? harnesses.join(", ") : "None allowed"} to="harnesses" />
        <NavRow label="Custom extensions" value={extensions} to="extensions" />
        <NavRow label="Friends" desc="People who share group chats with you." to="friends" />
      </SettingsGroup>

      <div className={cx("setting-row", "bots-set-danger")}>
        <div className="setting-text">
          <div className="setting-label">Reset OpenBots</div>
          <p className="setting-desc">Delete every bot, group and conversation, and start again.</p>
        </div>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog({ kind: "reset" })}>
          <RotateCcw size={14} /> Reset
        </button>
      </div>
      {dialogs}
    </>
  );
}
