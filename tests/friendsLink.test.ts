import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The host's side of a friend's connection, driven by hand with a socket that records what it's sent:
// the handshake, frames applied once and in order, acknowledgements clearing the outbox, what's waiting
// resent on reconnecting, and the rate limit, which holds across reconnects. In a subprocess, on a
// throwaway data dir.
test("a friend's connection applies each frame once, resends what's unacknowledged, and is cut off past the rate limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-friends-link-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      const store = await import('./server/friends/store.ts');
      const link = await import('./server/friends/link.ts');
      const { newKeyPair, loadKeyPair, seal, unseal } = await import('./server/friends/protocol.ts');
      const guest = loadKeyPair(newKeyPair());
      store.putFriend({ id: guest.id, name: 'Guest', publicKey: guest.publicKey, role: 'guest', mode: 'lan', listen: '127.0.0.1', addedAt: Date.now() });
      const me = store.identity();
      const applied = [];
      link.setHooks({ apply: (_f, kind, body) => applied.push(body.n), status() {}, removedByPeer() {} });

      const connect = () => {
        const sent = [];
        const ws = { data: { friendId: guest.id, nonce: crypto.randomUUID() }, closed: undefined, send: (t) => sent.push(unseal(t, me.publicKey)), close(code) { if (this.closed === undefined) { this.closed = code; link.accepting.close(ws); } } };
        link.accepting.open(ws);
        const challenge = sent.shift();
        a.equal(challenge.t, 'challenge');
        const sid = crypto.randomUUID();
        link.accepting.message(ws, seal({ t: 'auth', from: guest.id, to: me.id, nonce: challenge.nonce, sid }, guest));
        a.deepEqual(sent.shift(), { t: 'ready', from: me.id, to: guest.id, sid });
        const frame = (seq, n = seq) => link.accepting.message(ws, seal({ t: 'msg', from: guest.id, to: me.id, seq, kind: 'test', body: { n } }, guest));
        return { ws, sent, sid, frame };
      };

      // What's queued for them goes out as soon as they connect, and again until they acknowledge it.
      link.deliver(guest.id, 'note', { n: 'a' });
      link.deliver(guest.id, 'note', { n: 'b' });
      let c = connect();
      a.deepEqual(c.sent.filter((f) => f.t === 'msg').map((f) => [f.seq, f.body.n]), [[1, 'a'], [2, 'b']]);
      a.equal(link.online(guest.id), true);
      link.accepting.message(c.ws, seal({ t: 'ack', from: guest.id, to: me.id, sid: c.sid, seq: 1 }, guest));
      a.deepEqual(store.pending(guest.id).map((o) => o.seq), [2]);
      // An ack for another connection's session counts for nothing.
      link.accepting.message(c.ws, seal({ t: 'ack', from: guest.id, to: me.id, sid: 'someone-elses-session', seq: 2 }, guest));
      a.deepEqual(store.pending(guest.id).map((o) => o.seq), [2]);
      c.ws.close(1000);
      a.equal(link.online(guest.id), false);
      c = connect();
      a.deepEqual(c.sent.filter((f) => f.t === 'msg').map((f) => f.seq), [2]);

      // Their frames: applied once each, in order; a repeat is acknowledged as already had.
      c.frame(1); c.frame(2); c.frame(2); c.frame(1);
      a.deepEqual(applied, [1, 2]);
      const acks = c.sent.filter((f) => f.t === 'ack').map((f) => f.seq);
      a.deepEqual(acks, [1, 2, 2, 2]);
      // A heartbeat answers on the same session.
      link.accepting.message(c.ws, seal({ t: 'ping', from: guest.id, to: me.id, sid: c.sid }, guest));
      a.equal(c.sent.at(-1).t, 'pong');

      // Past the limit the connection closes, unacknowledged, and reconnecting doesn't reset the count.
      for (let seq = 3; seq <= 125 && c.ws.closed === undefined; seq++) c.frame(seq);
      a.equal(c.ws.closed, 4008);
      a.equal(applied.length, link.RATE_LIMIT);
      const last = applied.at(-1);
      c = connect();
      c.frame(last + 1);
      a.equal(c.ws.closed, 4008);
      a.equal(applied.length, link.RATE_LIMIT);

      // Removed: the next frame closes the connection as a stranger's.
      c = connect();
      store.deleteFriend(guest.id);
      c.frame(last + 2);
      a.equal(c.ws.closed, 4003);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
