// Friends: another person's OpenBuild, trusted far less than a paired device (which is the same
// owner's). A friend's server and this one connect over a protocol of their own (server/friends/) so
// their bots can talk in shared group chats, and that is all a friend can reach here. Shared by the
// server and the app.

export type FriendMode = "lan" | "tailscale";

/** A friend as the app shows them. Their key and addresses stay on the server. */
export interface FriendSummary {
  /** A short fingerprint of their server's public key: the same id on both sides. */
  id: string;
  name: string;
  /** "host": they shared their machine and this server connects to theirs. "guest": they connect here. */
  role: "host" | "guest";
  mode: FriendMode;
  /** refused: their server turned this one away, so they may have removed you. */
  status: "online" | "offline" | "refused";
  /** The key's fingerprint as people compare it: "a1b2-c3d4-e5f6-a7b8". */
  fingerprint: string;
  addedAt: number;
  lastSeenAt?: number;
  /** The owner let their bots use their usual tools in chats with this friend, not only chat. */
  allowTools?: boolean;
  /** Something they sent has kept failing to apply here. It's kept and tried again, and nothing after it is applied before it. */
  failing?: { since: number; attempts: number; error: string };
}

/** One of a friend's bots in a shared chat, as their server names it. */
export interface FriendMember {
  id: string;
  name: string;
  look?: { shape: string; color: string };
}

/** What makes a group chat a shared one, on this side. Each side keeps its own copy of the chat. */
export interface FriendChat {
  /** The friend, by id. */
  friend: string;
  friendName: string;
  /** The id both sides know the chat by. */
  chat: string;
  /** This side started it. */
  started?: boolean;
  /** The friend's bots in it. */
  members: FriendMember[];
  /** It doesn't sync anymore: the friend was removed (by either side), or they left the chat. */
  ended?: "removed" | "left";
}

/** Who wrote a friend's message, kept on the message as it arrived. */
export interface FriendFrom {
  friend: string;
  /** The friend themselves, rather than one of their bots. */
  owner?: boolean;
  /** Their bot's name, or the friend's name for their own messages. */
  name: string;
  friendName: string;
  look?: { shape: string; color: string };
}

/** The only tools a bot has in a chat shared with a friend, unless its owner allows that friend more. */
export const FRIEND_TOOLS = ["send_message", "react"];

const PREFIX = "friend:";
/** A friend's messages are written by "friend:<friend id>:<their bot's id, or owner>". */
export const OWNER = "owner";
export const friendAuthor = (friend: string, member: string) => `${PREFIX}${friend}:${member}`;
export const isFriendAuthor = (author: string) => author.startsWith(PREFIX);
export function parseFriendAuthor(author: string): { friend: string; member: string } | undefined {
  const match = /^friend:([a-f0-9]{24}):([A-Za-z0-9_-]{1,64})$/.exec(author);
  return match ? { friend: match[1]!, member: match[2]! } : undefined;
}

/** "a1b2c3d4e5f6a7b8…" → "a1b2-c3d4-e5f6-a7b8": enough of the key id to compare out loud. */
export const fingerprintOf = (id: string) => id.slice(0, 16).match(/.{4}/g)!.join("-");
