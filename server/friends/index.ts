// Friends: another person's OpenBuild that this one can share group chats with (see docs/friends.md).
// Pairing is for one owner's own devices and trusts them with projects, threads and shells; a friend
// is someone else, so all they get is the friend protocol on a listener of its own (listener.ts):
// connecting (link.ts), becoming friends (invites.ts) and shared chats (chats.ts). The CLI drives it
// over a local socket (control.ts), and the app lists and removes friends through /api/friends.
import * as svc from "../bots/service";
import * as chats from "./chats";
import * as control from "./control";
import * as link from "./link";
import * as listener from "./listener";
import { remove, summaries } from "./manage";

export function start() {
  link.setHooks({ apply: chats.apply, status: () => svc.emitFriends(), removedByPeer: (id) => void remove(id, true) });
  svc.setFriendHooks({ relay: chats.relay, members: chats.members, left: chats.left, list: summaries });
  link.startTimer();
  // Under `bun --hot` this runs again on every edit: listen afresh, so the friend port serves the current code.
  listener.stop();
  listener.sync();
  link.dialAll();
  control.listen();
  // An invite that expires closes the listener it opened, if nobody else needs it.
  const hot = globalThis as { openbuildFriendSweep?: ReturnType<typeof setInterval> };
  if (hot.openbuildFriendSweep) clearInterval(hot.openbuildFriendSweep);
  hot.openbuildFriendSweep = setInterval(() => listener.sync(), 30_000);
  hot.openbuildFriendSweep.unref?.();
}

export function stop() {
  link.stopAll();
  listener.stop();
  control.stop();
}
