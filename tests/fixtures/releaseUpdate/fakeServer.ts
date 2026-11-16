// The fake server's releases, for tests/releaseUpdate.test.ts: which release runs, which is out, an
// update that installs line by line as the test says, and a restart that comes back when the test
// lets it. It wraps the reload page's fake server, which answers everything else.
//
// What the "server" knows is kept in sessionStorage, so it's still the same server after the page
// reloads itself at the end of a restart. `?update=available|installing|ready` starts with a release on
// offer, one that is installing (started before this page loaded), or one installed and waiting; no
// parameter starts up to date.
import "../reloadScroll/fakeServer";
import type { ReleaseCheck } from "../../../shared/releaseUpdate";

const CHANGES = [
  "feat(bots): bots close their own question cards once they're settled another way (#351)",
  "fix(bots): Claude turns survive a reply with no visible output and a tool call with no result (#350)",
  "feat(bots): say what a bot is doing in another chat, with a calmer mascot (#349)",
  "fix(mobile): phones get the desktop's sidebar header and composers (#348)",
  "fix(releases): point at the repository's new home, dkod-ai/openbuild (#347)",
  "perf(sidebar): keep the thread list still while a reply streams (#346)",
  "feat(usage): show every machine's spend together (#345)",
  "fix(pi): keep a steer that lands between two tool calls (#344)",
];

interface Server {
  /** The release this server runs: what /api/config names. */
  running: { channel: "nightly" | "stable"; version: string };
  /** The newest release's tag, whether it's newer than the checkout, and whether it's installed and waiting. */
  latest: string;
  available: boolean;
  pending: boolean;
  changes: string[];
  reloads: number;
}
const start = new URLSearchParams(location.search).get("update");
const saved = sessionStorage.getItem("release-fixture");
const server: Server = saved ? JSON.parse(saved) : {
  running: { channel: "nightly", version: "0.3.52" },
  latest: start ? "0.3.53-nightly" : "0.3.52-nightly",
  available: start === "available" || start === "installing",
  pending: start === "ready",
  changes: CHANGES.slice(0, 3),
  reloads: -1,
};
server.reloads++;
const save = () => sessionStorage.setItem("release-fixture", JSON.stringify(server));
save();

const calls = { checks: 0, fresh: 0, updates: 0, restarts: 0 };
/** What the test holds back until it says: a check's answer, the restarted server. */
let checkGate: Promise<void> | undefined, openCheck = () => {};
let checkError: string | undefined, updateRefusal: string | undefined, restartError: string | undefined;
/** The update's job: what it has printed, and the stream following it once the app asks. */
let job: { id: string; said: string[]; follow?: ReadableStreamDefaultController<Uint8Array>; done: boolean } | undefined;
if (start === "installing" && !saved) job = { id: "job-0", said: [], done: false };
const enc = new TextEncoder();
const tell = () => {
  if (!job?.follow) return;
  for (const text of job.said.splice(0)) job.follow.enqueue(enc.encode(text));
  if (job.done) job.follow.close();
};
let restarting = false;

const check = (): ReleaseCheck => ({
  track: "nightly",
  current: server.pending ? server.latest : `${server.running.version}-nightly`,
  latest: server.latest,
  available: server.available,
  changes: server.available ? { changes: server.changes.slice(0, 40), total: server.changes.length } : undefined,
  restart: { pending: server.pending, error: restartError },
  updating: job && !job.done ? job.id : undefined,
});

const base = window.fetch;
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.href);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/config") return Response.json({ mode: "local", convexUrl: null, serverId: "fixture", machine: "imac", release: server.running });
  if (url.pathname === "/api/releases") {
    calls.checks++;
    if (url.searchParams.has("fresh")) {
      calls.fresh++;
      await checkGate;
      if (checkError) return Response.json({ error: checkError, restart: { pending: server.pending } }, { status: 502 });
    }
    return Response.json(check());
  }
  if (url.pathname === "/api/releases/update" && method === "POST") {
    calls.updates++;
    if (updateRefusal) return Response.json({ error: updateRefusal }, { status: 409 });
    job = { id: `job-${calls.updates}`, said: [], done: false };
    return Response.json({ job: job.id });
  }
  if (url.pathname === "/api/pi/job") {
    const following = job;
    // As the real server does, a job that has ended is still told from its start.
    if (!following) return new Response(null, { status: 204 });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        following.follow = controller;
        tell();
      },
    }), { headers: { "content-type": "application/x-ndjson" } });
  }
  if (url.pathname === "/api/releases/restart") {
    if (method === "POST") {
      calls.restarts++;
      restartError = undefined;
      restarting = true;
      return Response.json({ ok: true });
    }
    // A server that is restarting doesn't answer.
    if (restarting && !restartError) throw new TypeError("Failed to fetch");
    return Response.json({ pending: server.pending, error: restartError });
  }
  return base(input, init);
}) as typeof fetch;

/** The test's hands on the server. */
export const release = {
  server,
  calls,
  /** A newer release is published: the next check finds it. */
  publish(tag = "0.3.53-nightly", changes = CHANGES.slice(0, 3)) {
    Object.assign(server, { latest: tag, available: true, changes });
    save();
  },
  /** Holds the answer to the next asked-for checks until `answer()`. */
  hold() {
    checkGate = new Promise((resolve) => { openCheck = resolve; });
  },
  answer() {
    openCheck();
    checkGate = undefined;
  },
  failChecks(message?: string) { checkError = message; },
  refuseUpdates(message?: string) { updateRefusal = message; },
  /** A line of `ob update`'s output. */
  say(line: string) {
    job!.said.push(JSON.stringify({ line }) + "\n");
    tell();
  },
  /** The update ends: with 0 it's installed and waits for a restart. */
  finish(code = 0) {
    if (code === 0) Object.assign(server, { available: false, pending: true });
    save();
    job!.said.push(JSON.stringify({ done: true, code, title: "Updating OpenBuild" }) + "\n");
    job!.done = true;
    tell();
  },
  /** The restarted server answers: it runs the release that was installed. */
  back() {
    const version = /^\d+\.\d+\.\d+/.exec(server.latest)![0];
    Object.assign(server, { running: { channel: server.latest.endsWith("-nightly") ? "nightly" : "stable", version }, pending: false });
    save();
    restarting = false;
  },
  /** `ob restart` fails: the old server is still there, and says why. */
  failRestart(message: string) {
    restartError = message;
    restarting = false;
  },
};
Object.assign(window, { release });
