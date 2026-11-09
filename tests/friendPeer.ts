// One side of a friendship, for the tunnel tests: the friend link and listener only, on its own data
// directory (OPENCHAT_DATA_DIR), with no app server, bots or Pi. It says what happens as JSON lines on
// stdout and takes commands as JSON lines on stdin:
//   {"send": n}     deliver a synthetic frame { n } to the friend
//   {"remove": true} stop being friends, the way `openbuild friend remove` does on the link
//   {"exit": true}  stop everything and exit
// PEER_ROLE is host or guest, PEER_OTHER_KEY the friend's public key, PEER_URL (guest) where to dial,
// PEER_PLACE=1 (host) to start the tunnel the way an invite does, PEER_PING_MS to shorten heartbeats.
import { keyId } from "../server/friends/protocol";

const store = await import("../server/friends/store");
const link = await import("../server/friends/link");
const listener = await import("../server/friends/listener");
const { transports } = await import("../server/friends/transport");

const emit = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
const role = process.env.PEER_ROLE === "host" ? "host" : "guest";
const other = process.env.PEER_OTHER_KEY!;
const id = keyId(other);

if (process.env.PEER_PING_MS) {
  link.timing.pingEvery = Number(process.env.PEER_PING_MS);
  link.timing.silentFor = Number(process.env.PEER_PING_MS) * 4;
}
link.setHooks({
  apply: (_friend, _kind, body: any) => emit({ applied: body?.n }),
  status: () => emit({ online: link.online(id), refused: link.wasRefused(id) }),
  removedByPeer: () => emit({ removedByPeer: true }),
});
link.startTimer();

if (role === "host") {
  store.putFriend({ id, name: "Guest", publicKey: other, role: "guest", mode: "tunnel", listen: "127.0.0.1", addedAt: Date.now() });
  if (process.env.PEER_PLACE) {
    try {
      emit({ placed: await transports.tunnel.place({ port: store.listenPort() }) });
    } catch (err) {
      emit({ placeError: (err as Error).message });
    }
  }
  emit({ listening: listener.sync() });
} else {
  store.putFriend({ id, name: "Host", publicKey: other, role: "host", mode: "tunnel", urls: [process.env.PEER_URL!], addedAt: Date.now() });
  link.dialAll();
  emit({ dialing: true });
}

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk);
  let at;
  while ((at = buffered.indexOf("\n")) >= 0) {
    const command = JSON.parse(buffered.slice(0, at));
    buffered = buffered.slice(at + 1);
    if (command.send !== undefined) link.deliver(id, "note", { n: command.send });
    if (command.remove) {
      link.disconnect(id, true);
      store.deleteFriend(id);
      listener.sync();
      emit({ removed: true });
    }
    if (command.exit) {
      link.stopAll();
      listener.stop();
      process.exit(0);
    }
  }
}
