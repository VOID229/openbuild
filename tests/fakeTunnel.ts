// What the tunnel tests need around two friend peers (friendPeer.ts): a throwaway certificate, a fake
// relay, and a way to drive each peer.
//
// The fake relay stands in for an OpenTunnel relay and client together, as the two ends see them: the
// guest makes a TLS connection to it, and the host's friend listener gets the plain bytes from a
// loopback peer, copied unchanged. Like the real relay, it resets a connection that's been idle (no
// bytes either way) too long, and it can be cut, as if the relay restarted.
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Socket } from "bun";
import { newKeyPair } from "../server/friends/protocol";

/** A self-signed certificate for localhost, made for this run. */
export function certificate(dir: string): { cert: string; key: string; certFile: string } {
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdout: "ignore", stderr: "pipe" });
  if (made.exitCode !== 0) throw new Error(`openssl: ${made.stderr.toString()}`);
  return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8"), certFile };
}

interface Pair {
  upstream?: Socket<Pair>;
  client: Socket<Pair>;
  early: Uint8Array[];
  out: Map<Socket<Pair>, Uint8Array[]>;
  timer?: ReturnType<typeof setTimeout>;
}

export function fakeRelay(opts: { target: number; cert: string; key: string; idleMs: number }) {
  const pairs = new Set<Pair>();
  let opened = 0;
  const reset = (pair: Pair) => {
    clearTimeout(pair.timer);
    pairs.delete(pair);
    pair.client.terminate();
    pair.upstream?.terminate();
  };
  const touch = (pair: Pair) => {
    clearTimeout(pair.timer);
    pair.timer = setTimeout(() => reset(pair), opts.idleMs);
  };
  // Written in order, keeping what a socket couldn't take yet until it drains.
  const write = (pair: Pair, to: Socket<Pair>, bytes: Uint8Array) => {
    const queue = pair.out.get(to) ?? [];
    pair.out.set(to, queue);
    queue.push(bytes);
    flush(pair, to);
  };
  const flush = (pair: Pair, to: Socket<Pair>) => {
    const queue = pair.out.get(to) ?? [];
    while (queue.length) {
      const next = queue[0]!;
      const n = to.write(next);
      if (n < next.length) {
        queue[0] = next.subarray(Math.max(0, n));
        return;
      }
      queue.shift();
    }
  };
  const server = Bun.listen<Pair>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: opts.cert, key: opts.key },
    socket: {
      open: (client) => void connect(client),
      data(client, bytes) {
        const pair = connect(client);
        touch(pair);
        if (pair.upstream) write(pair, pair.upstream, new Uint8Array(bytes));
        else pair.early.push(new Uint8Array(bytes));
      },
      drain: (client) => client.data && flush(client.data, client),
      close: (client) => client.data && reset(client.data),
      error: (client) => client.data && reset(client.data),
    },
  });
  // On the first of open and data: Bun 1.3.8 can hand a TLS socket its first bytes before it opens it.
  function connect(client: Socket<Pair>): Pair {
    if (client.data) return client.data;
    opened++;
    const pair: Pair = { client, early: [], out: new Map() };
    client.data = pair;
    pairs.add(pair);
    touch(pair);
    Bun.connect<Pair>({
      hostname: "127.0.0.1",
      port: opts.target,
      data: pair,
      socket: {
        open(upstream) {
          pair.upstream = upstream;
          for (const bytes of pair.early) write(pair, upstream, bytes);
          pair.early = [];
        },
        data(_upstream, bytes) {
          touch(pair);
          write(pair, pair.client, new Uint8Array(bytes));
        },
        drain: (upstream) => flush(pair, upstream),
        close: () => reset(pair),
        error: () => reset(pair),
      },
    }).catch(() => reset(pair));
    return pair;
  }
  return {
    port: server.port,
    /** Connections the relay has carried, all told. */
    opened: () => opened,
    live: () => pairs.size,
    /** Drop every connection, as a relay restarting would. */
    cut: () => [...pairs].forEach(reset),
    stop: () => {
      for (const pair of [...pairs]) reset(pair);
      server.stop(true);
    },
  };
}

/** Throwaway identities for both sides, written where each peer's store looks for its own. */
export function identities(hostDir: string, guestDir: string) {
  const host = newKeyPair();
  const guest = newKeyPair();
  for (const [dir, key] of [[hostDir, host], [guestDir, guest]] as const) {
    mkdirSync(join(dir, "friends"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "friends", "identity.json"), JSON.stringify(key), { mode: 0o600 });
  }
  return { host, guest };
}

/** A shell wrapper for fakeOpentunnel.ts, to stand where the `opentunnel` binary would. */
export function fakeClientBin(dir: string): string {
  const file = join(dir, "opentunnel");
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dir, "fakeOpentunnel.ts")}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * `npm install -g opentunnel`, as it lays things out: on PATH, a symlink to the package's Node launcher
 * (`#!/usr/bin/env node`, which only finds node on a PATH), and the native client in the platform
 * package beside it: nested in the package's own node_modules, or `hoisted` next to it (bun's layout).
 * The native client here is the stand-in, fakeClientBin's.
 */
export function fakeNpmInstall(dir: string, opts: { hoisted?: boolean; native?: boolean } = {}): { launcher: string; native: string } {
  const modules = join(dir, "lib", "node_modules");
  const pkg = join(modules, "opentunnel");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  // As 0.6.2 publishes it: `bin/opentunnel`, a Node script with no extension.
  const script = join(pkg, "bin", "opentunnel");
  writeFileSync(script, `#!/usr/bin/env node\n\nconst childProcess = require("child_process")\n`);
  chmodSync(script, 0o755);
  const platformDir = join(opts.hoisted ? modules : join(pkg, "node_modules"), "@opentunnel", `cli-${process.platform}-${process.arch}`, "bin");
  mkdirSync(platformDir, { recursive: true });
  const native = join(platformDir, "opentunnel");
  if (opts.native !== false) {
    writeFileSync(native, `#!/bin/sh\nFAKE_OPENTUNNEL_SELF="$0" exec "${process.execPath}" "${resolve(import.meta.dir, "fakeOpentunnel.ts")}" "$@"\n`);
    chmodSync(native, 0o755);
  }
  mkdirSync(join(dir, "bin"), { recursive: true });
  const launcher = join(dir, "bin", "opentunnel");
  symlinkSync(script, launcher);
  return { launcher, native: realpathSync(dirname(native)) + "/opentunnel" };
}

export type Peer = ReturnType<typeof peer>;

/** One side, running friendPeer.ts: its events as they come, and commands to it. */
export function peer(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "friendPeer.ts")], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const events: any[] = [];
  let stderr = "";
  const waiting = new Set<() => void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffered += decoder.decode(chunk);
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        try {
          events.push(JSON.parse(line));
        } catch {}
        for (const fn of [...waiting]) fn();
      }
    }
  })();
  void new Response(child.stderr as ReadableStream<Uint8Array>).text().then((t) => (stderr = t));
  return {
    child,
    events,
    stderr: () => stderr,
    applied: () => events.filter((e) => "applied" in e).map((e) => e.applied),
    /** The first event `match` accepts, from the start (or `from` on), waiting up to `ms` for it. */
    next(match: (e: any) => boolean, ms = 15_000, from = 0): Promise<any> {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = events.slice(from).find(match);
          if (!hit) return;
          clearTimeout(timer);
          waiting.delete(check);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiting.delete(check);
          reject(new Error(`Timed out waiting; events so far: ${JSON.stringify(events)}; stderr: ${stderr}`));
        }, ms);
        waiting.add(check);
        check();
      });
    },
    send(command: Record<string, unknown>) {
      (child.stdin as import("bun").FileSink).write(JSON.stringify(command) + "\n");
      (child.stdin as import("bun").FileSink).flush();
    },
  };
}

/** Wait for `check`; one that throws (a file half-written) counts as not yet. */
export async function until(check: () => boolean, label: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  const ok = () => {
    try {
      return check();
    } catch {
      return false;
    }
  };
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(50);
  }
}

export const freePort = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};
