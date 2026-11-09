// Shared group chats: what the friend link carries for OpenBots. Each side keeps its own copy, an
// ordinary group with a `friend` field (shared/friends.ts), holding its owner's bots and showing the
// friend's. What crosses is plain text, said by the owner or one of their bots, and who's in the chat on
// each side; everything else about a chat (its instructions, reactions, polls, which bots read what)
// stays where it is.
//
// A friend's message is stored with a friend author and who wrote it, and wakes only the bots it
// mentions or replies to.
import type { BotMessage } from "../../shared/bots";
import { isBotId } from "../../shared/bots";
import { friendAuthor, OWNER, type FriendChat, type FriendMember } from "../../shared/friends";
import * as db from "../bots/db";
import * as svc from "../bots/service";
import { deviceName } from "../devices";
import { deliver } from "./link";
import { cleanName } from "./protocol";
import type { StoredFriend } from "./store";

/** The owner's name, as their friends see it. */
export const ownerName = () => cleanName(svc.getSettings().user?.name) || cleanName(deviceName()) || "Owner";

export function sharedChats(friendId?: string): db.StoredConversation[] {
  return db.listConversations().filter((c) => c.friend && (!friendId || c.friend.friend === friendId));
}
const byChat = (friendId: string, chat: string) => sharedChats(friendId).find((c) => c.friend!.chat === chat);

const membersOf = (c: db.StoredConversation): FriendMember[] =>
  c.botIds.flatMap((id) => {
    const bot = db.getBot(id);
    return bot ? [{ id: bot.id, name: bot.name, look: bot.look }] : [];
  });

/** A new chat shared with a friend, with the owner's choice of their bots in it. */
export function start(friend: StoredFriend, name: string, botIds: string[]) {
  const clean = cleanName(name, 80);
  if (!clean) throw new svc.BotsError("A shared chat needs a name.");
  const bots = [...new Set(botIds)].filter((id) => db.getBot(id));
  if (!bots.length) throw new svc.BotsError("Pick at least one of your bots to join it.");
  const id = crypto.randomUUID();
  const conversation = svc.createConversation({
    id,
    kind: "group",
    name: clean,
    botIds: bots,
    friend: { friend: friend.id, friendName: friend.name, chat: id, started: true, members: [] },
    messages: [{ id: crypto.randomUUID(), author: "me", at: Date.now(), text: "", event: { kind: "created", text: "Shared a group", detail: `${clean} with ${friend.name}` } }],
  });
  deliver(friend.id, "chat.open", { chat: id, name: clean, members: membersOf(db.getConversation(id)!), owner: ownerName() });
  return conversation;
}

// ------------------------------------------------------------------ this side, to the friend

/** One of this side's messages in a shared chat: plain text goes across, cards and photos stay here. */
export function relay(c: db.StoredConversation, message: BotMessage) {
  if (!c.friend || c.friend.ended || message.event || message.question || message.plan || message.poll || message.connect) return;
  const text = message.text.trim();
  if (!text) return;
  const member = message.author === "me" ? OWNER : db.getBot(message.author) ? message.author : undefined;
  if (!member) return;
  const name = member === OWNER ? ownerName() : db.getBot(member)!.name;
  // A reply keeps its quote only when the quoted message is in this chat, where both sides have it.
  const quoted = message.replyTo ? db.getMessage(message.replyTo) : undefined;
  const replyTo = quoted?.conversationId === c.id ? quoted.message.id : undefined;
  deliver(c.friend.friend, "chat.message", { chat: c.friend.chat, message: { id: message.id, member, name, text: text.slice(0, 8000), ...(replyTo ? { replyTo } : {}) } });
}

export function members(c: db.StoredConversation) {
  if (c.friend && !c.friend.ended) deliver(c.friend.friend, "chat.members", { chat: c.friend.chat, members: membersOf(c) });
}

export function left(c: db.StoredConversation) {
  if (c.friend && !c.friend.ended) deliver(c.friend.friend, "chat.leave", { chat: c.friend.chat });
}

// ------------------------------------------------------------------ the friend, to this side

const isChat = (x: unknown): x is string => isBotId(x);
const isMember = (x: unknown): x is string => x === OWNER || isBotId(x);
const event = (text: string, detail?: string): BotMessage => ({ id: crypto.randomUUID(), author: "me", at: Date.now(), text: "", event: { kind: "changed", text, ...(detail ? { detail } : {}) } });

function cleanMembers(list: unknown): FriendMember[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).flatMap((m) => {
    if (!m || !isBotId(m.id)) return [];
    const look = m.look && typeof m.look.shape === "string" && typeof m.look.color === "string" ? { shape: m.look.shape.slice(0, 40), color: m.look.color.slice(0, 40) } : undefined;
    return [{ id: m.id, name: cleanName(m.name, 80) || "Bot", ...(look ? { look } : {}) }];
  });
}

/** A frame from a friend, already checked: theirs, signed, new. What it says is still theirs, so it's all cleaned. */
export function apply(friend: StoredFriend, kind: string, body: any) {
  const chat = body?.chat;
  if (!isChat(chat)) return;
  const here = byChat(friend.id, chat);
  if (kind === "chat.open") {
    const name = cleanName(body.name, 80) || "Shared chat";
    if (here) return svc.updateSharedChat(here.id, { members: cleanMembers(body.members) });
    const shared: FriendChat = { friend: friend.id, friendName: friend.name, chat, members: cleanMembers(body.members) };
    svc.createConversation({
      kind: "group",
      name,
      botIds: [],
      friend: shared,
      messages: [event(`${friend.name} shared this chat with you`, "Add your bots from Members to bring them in. They only hear messages that mention them.")],
    });
    return;
  }
  // A chat this side doesn't have anymore (deleted, or Reset): say so, so the friend stops writing to it.
  if (!here) {
    if (kind !== "chat.leave") deliver(friend.id, "chat.leave", { chat });
    return;
  }
  if (here.friend!.ended) return;
  if (kind === "chat.members") return svc.updateSharedChat(here.id, { members: cleanMembers(body.members) });
  if (kind === "chat.leave") {
    svc.updateSharedChat(here.id, { ended: "left" });
    svc.postMessage(here.id, event(`${friend.name} left the chat`, "It doesn't sync anymore. You can still read it."));
    return;
  }
  if (kind !== "chat.message") return;
  const m = body.message;
  if (!m || !isBotId(m.id) || !isMember(m.member) || typeof m.text !== "string" || !m.text.trim()) return;
  // A message id this side already has elsewhere isn't theirs to reuse.
  const existing = db.getMessage(m.id);
  if (existing && existing.conversationId !== here.id) return;
  const owner = m.member === OWNER;
  const member = owner ? undefined : here.friend!.members.find((x) => x.id === m.member);
  const quoted = typeof m.replyTo === "string" && isBotId(m.replyTo) ? db.getMessage(m.replyTo) : undefined;
  const message: BotMessage = {
    id: m.id,
    author: friendAuthor(friend.id, m.member),
    at: Date.now(),
    text: m.text.slice(0, 8000),
    ...(quoted?.conversationId === here.id ? { replyTo: quoted.message.id } : {}),
    from: {
      friend: friend.id,
      ...(owner ? { owner: true } : {}),
      // The friend's own name is the one their owner approved here, not what each message claims.
      name: owner ? friend.name : member?.name ?? (cleanName(m.name, 80) || "Bot"),
      friendName: friend.name,
      ...(member?.look ? { look: member.look } : {}),
    },
  };
  svc.postMessage(here.id, message);
}

/** The friend is gone, removed by either side: their chats stay to read but stop syncing. */
export function endAll(friend: StoredFriend, byThem: boolean) {
  for (const c of sharedChats(friend.id)) {
    if (c.friend!.ended) continue;
    svc.updateSharedChat(c.id, { ended: "removed" });
    svc.postMessage(c.id, event(byThem ? `${friend.name} removed you as a friend` : `You removed ${friend.name} as a friend`, "This chat doesn't sync anymore. You can still read it."));
  }
}
