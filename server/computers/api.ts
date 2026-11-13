// One way into a computer, wherever it is. `dispatch` runs an operation on a computer on this
// machine; /api/computers/:id/:op exposes the same operations to the server this device is paired
// with (so a bot on that server can have its computer here); `computerApi(device)` is what the bots
// service uses: direct calls for "local", HTTP to the paired device otherwise.
//
// A paired server only gets what this machine allowed it (Settings → Devices → Using this device):
// files, terminal and browser are separate grants, all off after pairing, and so is running
// unisolated instead of in a container. They pick tools, not a boundary: a command can read files
// or start a browser too. The container is what keeps a bot apart from this machine. Its computers live apart from this machine's own bots', so
// it can only reach the ones its own bots made. Every answer names this server, and the caller
// refuses one from any other: a tool never runs on a machine the bot wasn't pointed at.
import { createHash } from "node:crypto";
import type { ComputerCapabilities, ComputerTarget } from "../../shared/bots";
import type { BotToolGrants } from "../../shared/types";
import * as devices from "../devices";
import type { StoredDevice } from "../devices";
import { bad, readJson } from "../handlers";
import { capabilities, computer, computerExists } from "./index";

/** The header every /api/computers answer carries: the server id of the machine that ran it. */
export const SERVER_HEADER = devices.SERVER_HEADER;

type Tool = "files" | "terminal" | "browser";
const TOOL_LABEL: Record<Tool, string> = { files: "files", terminal: "the terminal", browser: "the browser" };

/** The grant an operation needs. Undefined for looking after the computer itself, which any grant allows. */
function needs(op: string): Tool | undefined {
  if (op === "fs") return "files";
  if (op === "exec" || op === "proc") return "terminal";
  if (op === "browser") return "browser";
  return undefined;
}

/** A paired server's computer, apart from this machine's bots' and other paired servers'. */
export const guestComputerId = (clientId: string, id: string) => "g" + createHash("sha256").update(`${clientId}\n${id}`).digest("hex").slice(0, 40);

/** Why a paired server can't run `op` here, or undefined when it may. */
function refusal(who: { name: string; botTools: BotToolGrants }, op: string, kind: "container" | "host"): string | undefined {
  const here = devices.deviceName();
  const g = who.botTools;
  const tool = needs(op);
  if (tool && !g[tool]) return `${here} hasn't allowed ${TOOL_LABEL[tool]} for bots from ${who.name}. Allow it on ${here}: Settings → Devices → Using this device.`;
  if (!g.files && !g.terminal && !g.browser) return `${here} hasn't allowed bots from ${who.name} to use it. Allow them on ${here}: Settings → Devices → Using this device.`;
  if (kind === "host" && !g.unisolated) return `${here} only allows bots from ${who.name} a container, not unisolated access. Choose Container for ${here} in ${who.name}'s Settings → Devices, or allow Unisolated on ${here}.`;
  return undefined;
}

type Body = Record<string, any>;

const b64 = (d: Buffer) => d.toString("base64");

/** Run one operation on a computer here. `exec` streams output through `onData`. */
export async function dispatch(id: string, op: string, body: Body, signal?: AbortSignal, onData?: (chunk: Buffer) => void): Promise<unknown> {
  const c = computer(id, body.kind === "container" || body.kind === "host" ? body.kind : undefined);
  switch (op) {
    case "ensure":
      if (body.kind === "container" || body.kind === "host") await c.setKind(body.kind);
      await c.ensure();
      return c.info();
    case "info":
      return c.info();
    case "stop":
      await c.stop();
      return c.info();
    case "destroy":
      await c.destroy();
      return { ok: true };
    case "exec":
      return c.exec(String(body.command ?? ""), { cwd: body.cwd, timeout: Number(body.timeout) || undefined, env: body.env, onData, signal });
    case "fs": {
      const path = String(body.path ?? ".");
      switch (body.op) {
        case "read":
          return { data: b64(await c.readFile(path)) };
        case "write":
          await c.writeFile(path, Buffer.from(String(body.data ?? ""), "base64"));
          return { ok: true };
        case "mkdir":
          await c.mkdir(path);
          return { ok: true };
        case "access":
          await c.access(path);
          return { ok: true };
        case "stat":
          return c.stat(path);
        case "readdir":
          return { names: await c.readdir(path) };
        case "list":
          return c.list(path);
      }
      throw Object.assign(new Error(`Unknown file operation ${body.op}`), { status: 400 });
    }
    case "browser": {
      await c.ensure();
      const br = c.browser();
      switch (body.action) {
        case "open":
          return br.open(String(body.url ?? ""), !!body.newTab);
        case "history":
          return br.history(body.direction === "forward" ? "forward" : body.direction === "reload" ? "reload" : "back");
        case "snapshot":
          return br.snapshot(Number(body.max) || undefined);
        case "click":
          return br.click(String(body.ref ?? ""));
        case "type":
          return br.type(String(body.ref ?? ""), String(body.text ?? ""), { submit: !!body.submit, replace: body.replace !== false });
        case "press":
          return br.press(String(body.key ?? ""));
        case "scroll":
          return br.scroll(body.direction === "up" ? "up" : "down", Number(body.amount) || undefined);
        case "screenshot":
          return br.screenshot(!!body.fullPage);
        case "eval":
          return { value: await br.evaluateScript(String(body.script ?? "")) };
        case "tabs":
          return { tabs: await br.listTabs() };
        case "switch":
          return br.switchTab(Number(body.index));
        case "close":
          await br.closeTab(Number(body.index));
          return { tabs: await br.listTabs() };
        case "quit":
          br.close();
          return { ok: true };
      }
      throw Object.assign(new Error(`Unknown browser action ${body.action}`), { status: 400 });
    }
    case "proc":
      switch (body.op) {
        case "start":
          return c.startProc(String(body.command ?? ""), body.name, !!body.notify);
        case "read":
          return c.readProc(String(body.id ?? ""), { input: typeof body.input === "string" ? body.input : undefined, all: !!body.all });
        case "stop":
          return c.stopProc(String(body.id ?? ""));
        case "list":
          return { procs: c.listProcs() };
      }
      throw Object.assign(new Error(`Unknown process operation ${body.op}`), { status: 400 });
  }
  throw Object.assign(new Error(`Unknown computer operation ${op}`), { status: 404 });
}

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

const stamp = (res: Response) => {
  res.headers.set(SERVER_HEADER, devices.serverId());
  return res;
};

/** /api/computers: for this server's bots service, and for the server this device is paired with. */
export function computerRoutes(api: Api) {
  return {
    // Who this is and what the asking server's bots may do here, without probing container engines
    // (which can take seconds), so a caller can check it reached the right machine before every burst of tool calls.
    "/api/computers/identity": {
      GET: api((req: Request) => {
        const who = devices.authenticateDevice(req);
        return stamp(Response.json({ serverId: devices.serverId(), machine: devices.deviceName(), ...(who && { grants: who.botTools }) }));
      }),
    },
    "/api/computers/capabilities": {
      GET: api(async (req: Request) => {
        const who = devices.authenticateDevice(req);
        // A paired server also learns what it's allowed here, so its settings can say so before a bot tries.
        return stamp(Response.json({ ...(await capabilities()), serverId: devices.serverId(), machine: devices.deviceName(), ...(who && { grants: who.botTools }) } satisfies ComputerCapabilities));
      }),
    },
    // This server's own bots service never comes over HTTP (it calls `dispatch`), so this is for a
    // browser session only. A paired device has to use the bound route below.
    "/api/computers/:id/:op": {
      POST: api((req: Bun.BunRequest<"/api/computers/:id/:op">, server: Bun.Server<unknown>) => {
        if (presentsDeviceToken(req)) return stamp(bad("A paired device names the machine it means: /api/computers/to/<server id>/…", 403));
        return operate(req, server, req.params.id, req.params.op);
      }),
    },
    // A paired server's bots. The path names the machine the caller means, and this server runs it
    // only if that's itself: a request sent to an address that now belongs to another machine fails
    // there, and an older OpenBuild, which has no such route, never runs it at all.
    "/api/computers/to/:target/:id/:op": {
      POST: api((req: Bun.BunRequest<"/api/computers/to/:target/:id/:op">, server: Bun.Server<unknown>) => {
        if (!presentsDeviceToken(req)) return stamp(bad("Only a paired device uses this route", 403));
        if (req.params.target !== devices.serverId()) return stamp(bad(`This is ${devices.deviceName()}, not the machine this was meant for. Nothing ran.`, 409));
        return operate(req, server, req.params.id, req.params.op, true);
      }),
    },
  };
}

/**
 * A paired server's bots used to keep their computers here under the bare bot id. One with this
 * bot's id may hold its files, but whose it is can't be told here (this machine's own bots use bare
 * ids too, and so did every paired server), so it's neither taken over nor replaced with an empty
 * one: the bot stops with this until this machine's owner decides. Both stay as they are.
 */
const legacyRefusal = () =>
  `${devices.deviceName()} has a computer under this bot's id from before bots needed permission here. It wasn't used, changed or replaced, and nothing ran. ` +
  `${devices.deviceName()}'s owner has to decide what becomes of it before this bot can have a computer there; until then, use another machine.`;

/** A request that carries a device token. api() admits it only when the token is paired here, as a device, never as a browser. */
const presentsDeviceToken = (req: Request) => /^Bearer /.test(req.headers.get("authorization") ?? "");

/**
 * Run one operation for a request. A paired device's request is authenticated again once its body
 * has arrived, with the grants as they are then: a pairing revoked, or a grant taken back, while
 * the body was on its way fails it, and it never becomes a local request on the way.
 */
async function operate(req: Request, server: Bun.Server<unknown>, rawId: string, op: string, guest = false): Promise<Response> {
  server.timeout(req, 0);
  let body = ((await readJson(req)) ?? {}) as Body;
  let id = rawId;
  if (guest) {
    const who = devices.authenticateDevice(req);
    if (!who) return stamp(bad("Unknown device token", 401));
    try {
      id = guestComputerId(who.id, id);
      // A new guest computer is a container unless it asks otherwise; an existing one keeps its kind.
      // The asking server always says which on "ensure" (the host by default, where Unisolated is allowed).
      const asked = body.kind === "host" || body.kind === "container" ? body.kind : undefined;
      const c = computer(id, asked ?? "container");
      const why = refusal(who, op, op === "ensure" && asked ? asked : c.config.kind);
      if (why) return stamp(bad(why, 403));
      if (!computerExists(id) && computerExists(rawId)) return stamp(Response.json({ error: legacyRefusal(), legacy: true }, { status: 409 }));
      body = { ...body, kind: asked ?? c.config.kind };
    } catch (err) {
      const e = err as Error & { status?: number };
      return stamp(bad(e.message, e.status ?? 500));
    }
  }
  if (op === "exec") {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        try {
          const r = (await dispatch(id, op, body, req.signal, (d) => send({ t: "out", v: b64(d) }))) as { exitCode: number | null };
          send({ t: "exit", code: r.exitCode });
        } catch (err) {
          send({ t: "error", message: (err as Error).message });
        }
        controller.close();
      },
    });
    return stamp(new Response(stream, { headers: { "content-type": "application/x-ndjson" } }));
  }
  try {
    return stamp(Response.json(await dispatch(id, op, body, req.signal)));
  } catch (err) {
    const e = err as Error & { status?: number };
    return stamp(bad(e.message, e.status ?? 500));
  }
}

// ------------------------------------------------------------------ client

export interface ComputerApi {
  call<T = any>(id: string, op: string, body?: Body, signal?: AbortSignal): Promise<T>;
  exec(id: string, body: Body, onData: (chunk: Buffer) => void, signal?: AbortSignal): Promise<{ exitCode: number | null }>;
  capabilities(): Promise<ComputerCapabilities>;
  /**
   * What the machine allows this server's bots: everything here; on a paired device, what it said
   * when last found answering as itself (at most VERIFIED_FOR ago, or as Settings last listed it).
   * For choosing a default; the device checks its grants again itself on every request.
   */
  grants(): Promise<BotToolGrants | undefined>;
}

const local: ComputerApi = {
  call: (id, op, body = {}, signal) => dispatch(id, op, body, signal) as Promise<any>,
  exec: (id, body, onData, signal) => dispatch(id, "exec", body, signal, onData) as Promise<{ exitCode: number | null }>,
  capabilities: () => capabilities(),
  grants: async () => ({ files: true, terminal: true, browser: true, unisolated: true }),
};

/** Why a paired device's computer can't be used right now. A bot sees `message`; the settings show `reason`. */
export class TargetError extends Error {
  constructor(
    readonly reason: "unpaired" | "offline" | "revoked" | "denied" | "outdated" | "mismatch",
    message: string,
  ) {
    super(message);
  }
}

/** Where each paired device was last found answering as itself, and what it allowed then, so a burst of tool calls checks once. */
const verified = new Map<string, { base: string; at: number; grants?: BotToolGrants }>();
const VERIFIED_FOR = 15_000;

/**
 * The address a paired device answers at as itself, asked with a read-only request. This is for a
 * clear error before trying; what keeps an operation off the wrong machine is the bound route,
 * which the receiver checks itself, since the address can change after this answer.
 */
async function reach(device: StoredDevice, signal?: AbortSignal): Promise<string> {
  const known = verified.get(device.id);
  if (known && Date.now() - known.at < VERIFIED_FOR && device.urls.includes(known.base)) return known.base;
  verified.delete(device.id);
  let last = "it didn't answer";
  let refused: TargetError | undefined;
  for (const url of device.urls) {
    const base = url.replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/api/computers/identity`, { redirect: "error", headers: { authorization: `Bearer ${device.token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
      const answered = res.headers.get(SERVER_HEADER);
      let grants: BotToolGrants | undefined;
      if (res.ok && answered === device.id) grants = ((await res.json().catch(() => ({}))) as { grants?: BotToolGrants }).grants;
      else void res.body?.cancel().catch(() => {});
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        last = `it answered HTTP ${res.status}`;
        continue;
      }
      if (res.status === 401) throw new TargetError("revoked", `${device.name} no longer trusts this pairing. Nothing ran. Pair it again in Settings → Devices, or use another machine.`);
      if (answered === device.id) {
        devices.touchDevice(device.id, true);
        verified.set(device.id, { base, at: Date.now(), grants });
        return base;
      }
      // Another address may still be the right machine.
      refused ??= answered
        ? new TargetError("mismatch", `${base} isn't ${device.name} anymore: another OpenBuild answered there. Nothing ran.`)
        : new TargetError("outdated", `${device.name} needs a newer OpenBuild before bots can use it. Nothing ran.`);
    } catch (err) {
      if (err instanceof TargetError) throw err;
      if (signal?.aborted) throw new Error("aborted");
      last = (err as Error).message;
    }
  }
  throw refused ?? new TargetError("offline", `${device.name} is unreachable (${last}). Nothing ran; try again once it's online.`);
}

/** A request to a paired device's server, at the address it was just found answering as itself. */
async function deviceFetch(deviceId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const device = devices.deviceCredentials(deviceId);
  if (!device) throw new TargetError("unpaired", "That machine isn't paired with this server anymore. Nothing ran; use another machine.");
  const base = await reach(device, init.signal ?? undefined);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, redirect: "error", headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${device.token}`, "content-type": "application/json" } });
  } catch (err) {
    verified.delete(deviceId);
    if (init.signal?.aborted) throw new Error("aborted");
    throw new TargetError("offline", `${device.name} stopped answering (${(err as Error).message}).`);
  }
  if (res.status === 401) {
    verified.delete(deviceId);
    throw new TargetError("revoked", `${device.name} no longer trusts this pairing. Nothing ran. Pair it again in Settings → Devices, or use another machine.`);
  }
  if (res.headers.get(SERVER_HEADER) !== device.id) {
    verified.delete(deviceId);
    void res.body?.cancel().catch(() => {});
    throw new TargetError("mismatch", `${device.name}'s address answered as a different or older OpenBuild, which runs nothing it's sent this way. Nothing ran.`);
  }
  if (res.status === 403) throw new TargetError("denied", ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${device.name} hasn't allowed this.`);
  return res;
}

/** An operation's path, naming the machine it's for, which runs it only if that's itself. */
const bound = (deviceId: string, id: string, op: string) => `/api/computers/to/${encodeURIComponent(deviceId)}/${encodeURIComponent(id)}/${encodeURIComponent(op)}`;

function remote(deviceId: string): ComputerApi {
  return {
    async call(id, op, body = {}, signal) {
      const res = await deviceFetch(deviceId, bound(deviceId, id, op), { method: "POST", body: JSON.stringify(body), signal });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(data.error ?? `The device answered HTTP ${res.status}`);
      return data;
    },
    async exec(id, body, onData, signal) {
      const res = await deviceFetch(deviceId, bound(deviceId, id, "exec"), { method: "POST", body: JSON.stringify(body), signal });
      if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? `The device answered HTTP ${res.status}`);
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.t === "out") onData(Buffer.from(e.v, "base64"));
          else if (e.t === "exit") return { exitCode: e.code };
          else if (e.t === "error") throw new Error(e.message);
        }
      }
      throw new Error(signal?.aborted ? "aborted" : `${devices.deviceCredentials(deviceId)?.name ?? "The device"} stopped answering mid-command. It may have run partly.`);
    },
    async capabilities() {
      const res = await deviceFetch(deviceId, "/api/computers/capabilities");
      if (!res.ok) throw new Error(`The device answered HTTP ${res.status}. It may need a newer OpenBuild.`);
      return { ...((await res.json()) as ComputerCapabilities), device: deviceId };
    },
    async grants() {
      const device = devices.deviceCredentials(deviceId);
      if (!device) throw new TargetError("unpaired", "That machine isn't paired with this server anymore. Nothing ran; use another machine.");
      await reach(device);
      return verified.get(deviceId)?.grants;
    },
  };
}

export const computerApi = (device: string): ComputerApi => (device === "local" ? local : remote(device));

/** Every machine bots can reach, and what each allows them right now. Asks each paired device. */
export async function computerTargets(): Promise<ComputerTarget[]> {
  const here = await capabilities();
  const local: ComputerTarget = { device: "local", name: devices.deviceName(), status: "ready", grants: { files: true, terminal: true, browser: true, unisolated: true }, engines: here.engines };
  const remote = await Promise.all(
    devices.readDevices().map(async (d): Promise<ComputerTarget> => {
      try {
        const res = await deviceFetch(d.id, "/api/computers/identity");
        const g = ((await res.json().catch(() => ({}))) as { grants?: BotToolGrants }).grants;
        // What Settings shows is what the next tool call goes by (deviceGrants).
        const known = verified.get(d.id);
        if (known) known.grants = g;
        return { device: d.id, name: d.name, status: g && (g.files || g.terminal || g.browser) ? "ready" : "access", grants: g };
      } catch (err) {
        return { device: d.id, name: d.name, status: err instanceof TargetError ? (err.reason === "denied" ? "access" : err.reason) : "offline", message: (err as Error).message };
      }
    }),
  );
  return [local, ...remote];
}
