// Changing who this server's friends are, for the CLI's control socket and the app's routes alike.
import type { FriendSummary } from "../../shared/friends";
import { fingerprintOf } from "../../shared/friends";
import * as svc from "../bots/service";
import * as chats from "./chats";
import * as link from "./link";
import * as listener from "./listener";
import * as store from "./store";

export function summaries(): FriendSummary[] {
  return store.friends().map((f) => ({
    id: f.id,
    name: f.name,
    role: f.role,
    mode: f.mode,
    status: link.online(f.id) ? "online" : link.wasRefused(f.id) ? "refused" : "offline",
    fingerprint: fingerprintOf(f.id),
    addedAt: f.addedAt,
    lastSeenAt: f.lastSeenAt,
    ...(f.allowTools ? { allowTools: true } : {}),
    ...(link.failing(f.id) ? { failing: link.failing(f.id) } : {}),
  }));
}

/**
 * No longer friends, effective at once: their key is forgotten, so their next frame or connection is
 * refused, the connection closes, and what was waiting to go to them is dropped. `byThem` when their
 * server told this one it removed us.
 */
export function remove(id: string, byThem = false): boolean {
  const friend = store.friend(id);
  if (!friend) return false;
  link.disconnect(id, !byThem);
  store.deleteFriend(id);
  chats.endAll(friend, byThem);
  listener.sync();
  svc.emitFriends();
  return true;
}

/** Let bots use their usual tools in chats with this friend, or only chat (the default). */
export function setAllowTools(id: string, allow: boolean): boolean {
  if (!store.updateFriend(id, { allowTools: allow || undefined })) return false;
  svc.emitFriends();
  return true;
}

/** After a friend is added: listen for them, or dial them. */
export function added() {
  listener.sync();
  link.dialAll();
  svc.emitFriends();
}
