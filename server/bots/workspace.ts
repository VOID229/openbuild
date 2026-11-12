// Another device's tab using this server's OpenBots, and this server's tab using another's.
//
// Host side: /api/workspace/to/<server id>/api/bots/… runs only when the id is this server's own
// (409 otherwise, before the body is read), only for a paired device this machine's own session let
// use its workspace (Settings → Devices → Using this device), and only for what a tab does in
// conversations that already exist (ALLOWED). Everything else, from bot settings to apps, stays with
// this machine's own session. A device's request is authenticated again once its body has arrived,
// with the grant as it is then, and its streams close when the grant or the pairing goes.
//
// Viewer side: /api/workspace/via/<host id>/api/bots/… is this server's browser session reaching a
// paired host it holds the token for. It forwards to the host's bound route, never follows a
// redirect, and passes on only an answer that names that host. There's no fallback: an older or
// different OpenBuild at the address runs nothing, and an offline host is shown as unreachable.
//
// Which workspace a tab shows is the tab's own choice (src/lib/bots/workspace.ts). This server keeps
// the pairing credentials only, never a current host.
import { SERVER_HEADER } from "../computers/api";
import * as devices from "../devices";
import { forwardBody } from "../forwardFile";
import { attachedFile, receiveFile, botFile, botRoutes, botsStream, deleteMine, markRead, olderMessages, patchMine, postMine, snapshotResponse, stopWork } from "./routes";
import * as svc from "./service";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;
type Who = NonNullable<ReturnType<typeof devices.authenticateDevice>>;
/** `body` is parsed already: a write runs without awaiting anything once its grant was checked. */
type Run = (req: Request, args: string[], body: any, server: Bun.Server<unknown>, who?: Who) => Response | Promise<Response>;

const ID = "([^/]+)";
/** `raw`: the body is a piece of a file, handed over as bytes instead of parsed. */
const route = (method: string, path: string, run: Run, raw = false) => ({ method, path: new RegExp(`^${path.replaceAll(":id", ID)}$`), run, raw });

/** Everything a paired device can do in this workspace. Anything not listed is refused. */
const ALLOWED = [
  route("GET", "/api/bots", () => snapshotResponse()),
  route("GET", "/api/bots/stream", (req, _, __, server, who) => {
    if (who) return botsStream(req, server, (close) => track(who.id, close));
    // This server's own tab: the first time OpenBots opens here, the primary bot says hello.
    const res = botsStream(req, server);
    void svc.greetOnFirstOpen();
    return res;
  }),
  route("GET", "/api/bots/conversations/:id/messages", (req, [id]) => olderMessages(req, id!)),
  route("POST", "/api/bots/conversations/:id/messages", (_, [id], body) => postMine(id!, body)),
  route("PATCH", "/api/bots/conversations/:id/messages/:id", (_, [id, message], body) => patchMine(id!, message!, body)),
  route("DELETE", "/api/bots/conversations/:id/messages/:id", (_, [id, message]) => deleteMine(id!, message!)),
  route("POST", "/api/bots/conversations/:id/read", (_, [id]) => markRead(id!)),
  route("POST", "/api/bots/conversations/:id/stop", (_, [id], body) => stopWork(id!, body)),
  route("GET", "/api/bots/:id/file", (req, [id]) => botFile(req, id!)),
  route("PUT", "/api/bots/conversations/:id/files/:id", (req, [id, file], body) => receiveFile(req, id!, file!, body ?? new Uint8Array()), true),
  route("GET", "/api/bots/conversations/:id/files/:id", (req, [id, file]) => attachedFile(req, id!, file!)),
];

/** The allowed operation for a method and an /api/bots path, with its decoded path arguments. */
export function allowedOperation(method: string, path: string): { run: Run; args: string[]; raw: boolean } | undefined {
  for (const r of ALLOWED) {
    if (r.method !== method) continue;
    const m = r.path.exec(path);
    if (!m) continue;
    try {
      return { run: r.run, args: m.slice(1).map(decodeURIComponent), raw: r.raw };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ host side

/** Each paired device's open streams, closed when it may no longer use the workspace. */
const streams = new Map<string, Set<() => void>>();

function track(clientId: string, close: () => void): () => void {
  let set = streams.get(clientId);
  if (!set) streams.set(clientId, (set = new Set()));
  set.add(close);
  return () => {
    set.delete(close);
    if (!set.size && streams.get(clientId) === set) streams.delete(clientId);
  };
}

devices.onAccessNarrowed((clientId) => {
  if (devices.pairedClients().some((c) => c.id === clientId && c.workspace)) return;
  for (const close of [...(streams.get(clientId) ?? [])]) close();
});

/** How many streams a paired device has open here, for tests and diagnostics. */
export const openStreams = (clientId: string) => streams.get(clientId)?.size ?? 0;

const stamp = (res: Response) => {
  res.headers.set(SERVER_HEADER, devices.serverId());
  return res;
};
const refuse = (error: string, status: number, reason: string) => stamp(Response.json({ error, reason }, { status }));
const presentsDeviceToken = (req: Request) => /^Bearer /.test(req.headers.get("authorization") ?? "");

/** Why a paired device can't use this workspace right now, or undefined when it can. */
function deviceRefusal(who: Who | undefined): Response | undefined {
  if (!who) return refuse("This device's pairing isn't known here anymore. Pair it again.", 401, "revoked");
  const here = devices.deviceName();
  if (!who.workspace) return refuse(`${here} hasn't let ${who.name} use its OpenBots workspace. Allow it on ${here}: Settings → Devices → Using this device.`, 403, "denied");
  return undefined;
}

/**
 * Everything else this server's own session does with its bots (making them, settings, apps), on
 * the same bound route, so a tab's management writes run only on the server it means. Never a
 * paired device's: those reach ALLOWED only. The apps sign-in callback stays on its own public route.
 */
let owner: { method: string; path: RegExp; names: string[]; handle: (req: Request, server: Bun.Server<unknown>) => Response | Promise<Response> }[] | undefined;
function ownerOperation(method: string, path: string) {
  owner ??= Object.entries(botRoutes((handler) => handler) as unknown as Record<string, Record<string, (req: Request, server: Bun.Server<unknown>) => Response | Promise<Response>>>)
    .filter(([pattern]) => pattern !== "/api/bots/apps/callback")
    .flatMap(([pattern, methods]) => {
      const names = [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]!);
      const path = new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`);
      return Object.entries(methods).map(([method, handle]) => ({ method, path, names, handle }));
    })
    // Literal paths before ones with parameters, as Bun's router picks them (/api/bots/settings before /api/bots/:id).
    .sort((a, b) => a.names.length - b.names.length);
  for (const r of owner) {
    if (r.method !== method) continue;
    const m = r.path.exec(path);
    if (!m) continue;
    try {
      return { handle: r.handle, params: Object.fromEntries(r.names.map((name, i) => [name, decodeURIComponent(m[i + 1]!)])) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function bound(req: Bun.BunRequest<"/api/workspace/to/:target/*">, server: Bun.Server<unknown>): Promise<Response> {
  server.timeout(req, 0);
  const target = req.params.target;
  // Before anything else, and before the body: a request meant for another machine runs nothing here.
  if (target !== devices.serverId()) return refuse(`This is ${devices.deviceName()}, not the workspace this was meant for. Nothing ran.`, 409, "mismatch");
  const device = presentsDeviceToken(req);
  if (device) {
    const why = deviceRefusal(devices.authenticateDevice(req));
    if (why) return why;
  }
  const url = new URL(req.url);
  const path = url.pathname.slice(`/api/workspace/to/${encodeURIComponent(target)}`.length);
  const op = allowedOperation(req.method, path);
  const managed = !op && !device ? ownerOperation(req.method, path) : undefined;
  if (!op && !managed) return refuse("That isn't something a workspace tab can do here. Bots and the workspace are managed in its own session.", 403, "refused");
  const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  if (managed) {
    // This server's own session (api() checked it): its handler reads the body itself.
    const inner = Object.assign(new Request(new URL(path + url.search, url.origin), { method: req.method, headers: req.headers, body: raw, signal: req.signal }), { params: managed.params });
    return stamp(await managed.handle(inner, server));
  }
  let body: unknown;
  if (op!.raw) body = raw && new Uint8Array(raw);
  else if (raw?.byteLength) {
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      body = undefined;
    }
  }
  // The grant as it is now that the body is here: one taken back meanwhile fails closed. Nothing is
  // awaited from here until the change is made, so it can't be taken back in between either.
  let who: Who | undefined;
  if (device) {
    who = devices.authenticateDevice(req);
    const why = deviceRefusal(who);
    if (why) return why;
  }
  const inner = new Request(new URL(path + url.search, url.origin), { method: req.method, headers: req.headers, signal: req.signal });
  return stamp(await op!.run(inner, op!.args, body, server, who));
}

// ------------------------------------------------------------------ viewer side

/** How long a host gets to send response headers, as for the device proxy in index.ts. */
const HEADER_TIMEOUT_MS = 6000;
const PASSED_HEADERS = ["content-type", "cache-control", "content-disposition", "x-content-type-options", "accept-ranges", "content-range", "content-security-policy", SERVER_HEADER];
/** A piece of a file has to arrive in full before the host answers, and its bots get the file before the last one does. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** Streams this server's tabs have open through each host, ended when the host is unpaired here. */
const viaStreams = new Map<string, Set<AbortController>>();
devices.onHostRemoved((hostId) => {
  for (const ctrl of [...(viaStreams.get(hostId) ?? [])]) ctrl.abort();
});

/** A connection that never reached a server, so trying the host's next address can't run anything twice. */
const neverConnected = (err: unknown) => /ConnectionRefused|ECONNREFUSED|FailedToOpenSocket|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|Unable to connect/i.test(`${(err as { code?: string }).code ?? ""} ${(err as Error).message ?? ""}`);

async function via(req: Bun.BunRequest<"/api/workspace/via/:host/*">, server: Bun.Server<unknown>): Promise<Response> {
  server.timeout(req, 0);
  const hostId = req.params.host;
  const host = devices.deviceCredentials(hostId);
  if (!host) return Response.json({ error: "That workspace's device isn't paired with this one.", reason: "unpaired" }, { status: 404 });
  const url = new URL(req.url);
  const path = url.pathname.slice(`/api/workspace/via/${encodeURIComponent(hostId)}`.length);
  if (!allowedOperation(req.method, path)) return Response.json({ error: "That isn't something a workspace tab can do on another device.", reason: "refused" }, { status: 403 });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const headers: Record<string, string> = { authorization: `Bearer ${host.token}` };
  for (const name of ["content-type", "accept", "range", "if-range"]) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }
  const streaming = path === "/api/bots/stream";
  const timeout = req.method === "PUT" ? UPLOAD_TIMEOUT_MS : HEADER_TIMEOUT_MS;
  let last = "it didn't answer";
  for (const base of host.urls) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    req.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, timeout);
    let res: Response;
    try {
      res = await fetch(`${base.replace(/\/$/, "")}/api/workspace/to/${encodeURIComponent(hostId)}${path}${url.search}`, { method: req.method, headers, body, redirect: "manual", signal: ctrl.signal });
    } catch (err) {
      clearTimeout(deadline);
      req.signal.removeEventListener("abort", abort);
      last = req.signal.aborted ? "the tab went away" : ctrl.signal.aborted ? `no answer in ${timeout / 1000}s` : (err as Error).message;
      // A write that may have reached the host isn't sent anywhere else.
      if (body !== undefined && !neverConnected(err)) break;
      continue;
    }
    clearTimeout(deadline);
    const answered = res.headers.get(SERVER_HEADER);
    if (answered !== hostId || (res.status >= 300 && res.status < 400)) {
      req.signal.removeEventListener("abort", abort);
      void res.body?.cancel().catch(() => {});
      const reason = res.status >= 300 && res.status < 400 ? "redirect" : answered ? "mismatch" : "outdated";
      const error = {
        redirect: `${base} answered with a redirect, which isn't followed. Nothing was sent on.`,
        mismatch: `${base} isn't ${host.name} anymore: another OpenBuild answered there. Nothing ran.`,
        outdated: `${host.name} at ${base} needs a newer OpenBuild before its workspace can be used from here. Nothing ran.`,
      }[reason];
      return Response.json({ error, reason }, { status: 502 });
    }
    devices.touchDevice(hostId, true);
    const out = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = res.headers.get(name);
      if (value) out.set(name, value);
    }
    if (!streaming || !res.ok || !res.body) {
      req.signal.removeEventListener("abort", abort);
      if (res.status === 401) return Response.json({ error: `${host.name} no longer trusts this pairing. Pair it again.`, reason: "revoked" }, { status: 401, headers: out });
      return forwardBody(res, out);
    }
    let set = viaStreams.get(hostId);
    if (!set) viaStreams.set(hostId, (set = new Set()));
    set.add(ctrl);
    const done = () => {
      set.delete(ctrl);
      req.signal.removeEventListener("abort", abort);
    };
    req.signal.addEventListener("abort", done, { once: true });
    return new Response(res.body.pipeThrough(new TransformStream({ flush: done })), { status: res.status, headers: out });
  }
  return Response.json({ error: `${host.name} is unreachable (${last}).`, reason: "offline" }, { status: 502 });
}

export function workspaceRoutes(api: Api) {
  // Every answer names this server, api()'s own refusals included.
  const wrapped = api(bound);
  const to = async (req: Bun.BunRequest<"/api/workspace/to/:target/*">, server: Bun.Server<unknown>) => stamp(await wrapped(req, server));
  const through = api(via);
  return {
    "/api/workspace/to/:target/*": {
      GET: to,
      POST: to,
      PUT: to,
      PATCH: to,
      DELETE: to,
    },
    // A browser session here only: devicePathAllowed keeps paired devices off it.
    "/api/workspace/via/:host/*": {
      GET: through,
      POST: through,
      PUT: through,
      PATCH: through,
      DELETE: through,
    },
  };
}
